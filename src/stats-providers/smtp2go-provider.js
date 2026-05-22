import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BaseStatsProvider } from "./base-provider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SMTP2GO_BASE_URL = "https://api.smtp2go.com/v3";
const DEFAULT_DAILY_LIMIT = 200; // SMTP2GO free accounts: 200 emails/day

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Detect SMTP/API errors that indicate throttling, so we can back a provider off. */
export function isRateLimitError(error) {
  if (!error) return false;
  const code = error.responseCode || error.statusCode || error.status;
  if (code === 421 || code === 429 || code === 450 || code === 451) return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many") ||
    msg.includes("throttl") ||
    msg.includes("quota") ||
    msg.includes("try again later")
  );
}

/**
 * SMTP2GO stats provider with quota-aware load balancing.
 *
 * For each provider it tracks:
 *  - a local daily counter (persisted to disk, reset on date rollover)
 *  - the API-reported "emails sent today" (authoritative after a restart)
 *  - monthly cycle usage from the API (5-minute cache)
 *  - in-flight reservations (so concurrent deliveries don't oversend)
 *  - a short-term rate window and an error cooldown
 *
 * Selection picks the eligible provider with the most effective remaining
 * quota (min of daily and monthly headroom), draining all accounts evenly so
 * none gets hammered hard enough to trigger SMTP2GO rate limiting.
 */
export class Smtp2goStatsProvider extends BaseStatsProvider {
  constructor(config, logger) {
    super(config, logger);

    const opts = config.smtp2go || {};
    this.cacheTtl = opts.pollIntervalMs || 5 * 60 * 1000;
    this.apiTimeout = opts.apiTimeoutMs || 15000;
    this.reserveRatio = clamp(opts.dailyReserveRatio ?? 0.02, 0, 0.5);
    this.maxPerMinute =
      opts.rateLimit && Number.isFinite(opts.rateLimit.maxPerMinute)
        ? opts.rateLimit.maxPerMinute
        : 0; // 0 = no short-term cap
    this.errorCooldownMs = opts.errorCooldownMs ?? 5 * 60 * 1000;
    this.timezone = opts.timezone || "UTC";

    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(__dirname, "..", "..", "data");
    this.statePath = path.join(dataDir, "smtp2go-state.json");

    // API response cache: providerName -> raw stats
    this.cache = { timestamp: 0, data: {} };
    this._refreshing = null;
    this._saveScheduled = false;

    // Per-provider runtime state
    this.providers = new Map();
    for (const p of config.providers) {
      if (!p.api_key) {
        throw new Error(
          `Provider "${p.name}" missing "api_key" (required for smtp2go mode)`,
        );
      }
      this.providers.set(p.name, {
        name: p.name,
        apiKey: p.api_key,
        dailyLimit: p.daily_limit || DEFAULT_DAILY_LIMIT,
        monthlyLimitOverride: p.monthly_limit || null,
        dailyCounter: 0, // local sends today
        sinceRefresh: 0, // sends since last successful API refresh
        inFlight: 0, // reserved but not yet completed
        sendTimes: [], // recent send timestamps (rate window)
        cooldownUntil: 0, // epoch ms; provider skipped until then
        lastSelectedAt: 0, // tie-breaker (least-recently-used)
        consecutiveErrors: 0,
      });
    }

    this.currentDate = this._getCurrentDate();
    this._loadState();
  }

  // ----- date / persistence -------------------------------------------------

  _getCurrentDate() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: this.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  _loadState() {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (raw.date === this.currentDate && raw.counters) {
        for (const [name, count] of Object.entries(raw.counters)) {
          const p = this.providers.get(name);
          if (p && Number.isFinite(count)) p.dailyCounter = count;
        }
        this.logger.info("Restored SMTP2GO daily counters from disk", {
          date: raw.date,
        });
      }
    } catch (err) {
      this.logger.warn("Could not restore SMTP2GO state", {
        error: err.message,
      });
    }
  }

  _saveState() {
    if (this._saveScheduled) return;
    this._saveScheduled = true;
    const timer = setTimeout(() => {
      this._saveScheduled = false;
      try {
        const counters = {};
        for (const [name, p] of this.providers) counters[name] = p.dailyCounter;
        fs.writeFileSync(
          this.statePath,
          JSON.stringify({ date: this.currentDate, counters }),
        );
      } catch (err) {
        this.logger.warn("Could not persist SMTP2GO state", {
          error: err.message,
        });
      }
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  _checkDateRollover() {
    const today = this._getCurrentDate();
    if (today !== this.currentDate) {
      this.logger.info("SMTP2GO daily counters reset", {
        from: this.currentDate,
        to: today,
      });
      this.currentDate = today;
      for (const p of this.providers.values()) {
        p.dailyCounter = 0;
        p.sinceRefresh = 0;
      }
      this._saveState();
    }
  }

  // ----- quota maths --------------------------------------------------------

  /** Compute live quota figures for a provider. */
  _metrics(p) {
    const api = this.cache.data[p.name] || {};

    // Daily: trust whichever is higher — the local counter (accurate while
    // running) or the API's today-count (accurate after a restart).
    const apiDaily = api.daily_api_count ?? 0;
    const dailyUsed = Math.max(p.dailyCounter, apiDaily) + p.inFlight;
    const effectiveDailyLimit = Math.max(
      0,
      Math.floor(p.dailyLimit * (1 - this.reserveRatio)),
    );
    const dailyRemaining = Math.max(0, effectiveDailyLimit - dailyUsed);

    // Monthly: cycle data is up to `cacheTtl` stale, so discount sends made
    // since the last refresh (and current in-flight).
    let monthlyRemaining = Infinity;
    if (p.monthlyLimitOverride) {
      monthlyRemaining = Math.max(
        0,
        p.monthlyLimitOverride - (api.cycle_used ?? 0) - p.sinceRefresh - p.inFlight,
      );
    } else if (Number.isFinite(api.cycle_remaining)) {
      monthlyRemaining = Math.max(
        0,
        api.cycle_remaining - p.sinceRefresh - p.inFlight,
      );
    }

    const effectiveRemaining = Math.min(dailyRemaining, monthlyRemaining);
    return {
      api,
      apiDaily,
      dailyUsed,
      effectiveDailyLimit,
      dailyRemaining,
      monthlyRemaining,
      effectiveRemaining,
    };
  }

  /** True if the provider is under its short-term rate cap. */
  _rateOk(p, now) {
    if (!this.maxPerMinute) return true;
    p.sendTimes = p.sendTimes.filter((t) => now - t < 60000);
    return p.sendTimes.length < this.maxPerMinute;
  }

  // ----- counters (called by the delivery pipeline) -------------------------

  incrementSent(providerName) {
    this._checkDateRollover();
    const p = this.providers.get(providerName);
    if (!p) return;
    p.dailyCounter++;
    p.sinceRefresh++;
    if (p.inFlight > 0) p.inFlight--;
    p.consecutiveErrors = 0;
    this.logger.debug(
      `SMTP2GO ${providerName}: ${p.dailyCounter}/${p.dailyLimit} today`,
    );
    this._saveState();
  }

  incrementError(providerName, error) {
    const p = this.providers.get(providerName);
    if (!p) return;
    if (p.inFlight > 0) p.inFlight--;
    p.consecutiveErrors++;

    const throttled = isRateLimitError(error);
    if (throttled || p.consecutiveErrors >= 3) {
      p.cooldownUntil = Date.now() + this.errorCooldownMs;
      this.logger.warn(`Provider ${providerName} placed in cooldown`, {
        until: new Date(p.cooldownUntil).toISOString(),
        reason: throttled ? "rate-limit" : "consecutive-errors",
      });
    }
  }

  /** Release a reservation made by getBestProvider() with no send attempt. */
  releaseReservation(providerName) {
    const p = this.providers.get(providerName);
    if (p && p.inFlight > 0) p.inFlight--;
  }

  // ----- selection ----------------------------------------------------------

  /** Eligible providers, best (most effective remaining quota) first. */
  getRankedProviders() {
    this._checkDateRollover();
    const now = Date.now();
    const eligible = [];
    for (const p of this.providers.values()) {
      if (p.cooldownUntil > now) continue;
      if (!this._rateOk(p, now)) continue;
      const m = this._metrics(p);
      if (m.effectiveRemaining <= 0) continue;
      eligible.push({
        name: p.name,
        remaining: m.effectiveRemaining,
        last: p.lastSelectedAt,
      });
    }
    // Most headroom first; on a tie, least-recently-used first.
    eligible.sort((a, b) => b.remaining - a.remaining || a.last - b.last);
    return eligible.map((e) => e.name);
  }

  /**
   * Select the next provider and reserve a slot on it. Returns null when every
   * provider is exhausted, rate-limited, or cooling down (caller should retry).
   */
  getBestProvider() {
    const ranked = this.getRankedProviders();
    if (ranked.length === 0) return null;
    const p = this.providers.get(ranked[0]);
    const now = Date.now();
    p.inFlight++;
    p.lastSelectedAt = now;
    p.sendTimes.push(now);
    return p.name;
  }

  // Backwards-compatible alias.
  getProvidersSortedByQuota() {
    return this.getRankedProviders();
  }

  // ----- API polling --------------------------------------------------------

  async _fetchProviderStats(provider) {
    const headers = {
      "Content-Type": "application/json",
      "X-Smtp2go-Api-Key": provider.apiKey,
    };
    const today = this._getCurrentDate();
    const post = (endpoint, body = {}) =>
      axios.post(`${SMTP2GO_BASE_URL}${endpoint}`, body, {
        headers,
        timeout: this.apiTimeout,
      });

    const [summaryRes, cycleRes, dailyRes, bouncesRes, spamRes] =
      await Promise.allSettled([
        post("/stats/email_summary"),
        post("/stats/email_cycle"),
        post("/stats/email_summary", { date_from: today, date_to: today }),
        post("/stats/email_bounces"),
        post("/stats/email_spam"),
      ]);

    // If the two essential calls both fail, treat the provider as errored.
    if (summaryRes.status === "rejected" && cycleRes.status === "rejected") {
      throw summaryRes.reason;
    }

    const body = (res) =>
      res.status === "fulfilled" ? res.value.data?.data || {} : {};
    const summary = body(summaryRes);
    const cycle = body(cycleRes);
    const daily = body(dailyRes);
    const bounces = body(bouncesRes);
    const spam = body(spamRes);

    return {
      type: "smtp2go",
      total_emails: summary.email_count || 0,
      daily_api_count: daily.email_count || 0,
      cycle_used: cycle.cycle_used || 0,
      cycle_max: cycle.cycle_max || 0,
      cycle_remaining: cycle.cycle_remaining ?? null,
      cycle_percent:
        cycle.cycle_max > 0
          ? (cycle.cycle_used / cycle.cycle_max) * 100
          : 0,
      hard_bounces: bounces.hardbounces || 0,
      soft_bounces: bounces.softbounces || 0,
      bounce_percent: parseFloat(bounces.bounce_percent) || 0,
      spam_count: spam.spams || 0,
      spam_percent: parseFloat(spam.spam_percent) || 0,
    };
  }

  async _refresh() {
    this.logger.info("Refreshing SMTP2GO stats...");
    const results = {};
    await Promise.all(
      [...this.providers.values()].map(async (p) => {
        try {
          results[p.name] = await this._fetchProviderStats(p);
          // API figures are now current — discount window resets.
          p.sinceRefresh = 0;
        } catch (err) {
          this.logger.error(`Failed to fetch SMTP2GO stats for ${p.name}`, {
            error: err.message,
          });
          results[p.name] = {
            ...(this.cache.data[p.name] || {}),
            error: err.message,
          };
        }
      }),
    );
    this.cache.data = results;
    this.cache.timestamp = Date.now();
  }

  async getStats() {
    this._checkDateRollover();
    const fresh =
      Date.now() - this.cache.timestamp < this.cacheTtl &&
      Object.keys(this.cache.data).length > 0;

    if (!fresh) {
      // Coalesce concurrent refreshes into one API round-trip.
      if (!this._refreshing) {
        this._refreshing = this._refresh().finally(() => {
          this._refreshing = null;
        });
      }
      await this._refreshing;
    }
    return this._decorate();
  }

  /** Build the per-provider view served to the API/dashboard. */
  _decorate() {
    const now = Date.now();
    const out = {};
    for (const p of this.providers.values()) {
      const m = this._metrics(p);
      const api = m.api;

      let status = "ok";
      if (api.error) status = "error";
      else if (p.cooldownUntil > now) status = "cooldown";
      else if (m.dailyRemaining <= 0) status = "daily-exhausted";
      else if (m.monthlyRemaining <= 0) status = "monthly-exhausted";
      else if (!this._rateOk(p, now)) status = "rate-limited";

      const dailySent = Math.max(p.dailyCounter, m.apiDaily);

      out[p.name] = {
        type: "smtp2go",
        status,
        error: api.error || null,
        in_flight: p.inFlight,

        daily_sent: dailySent,
        daily_limit: p.dailyLimit,
        daily_effective_limit: m.effectiveDailyLimit,
        daily_remaining: m.dailyRemaining,
        daily_percent:
          p.dailyLimit > 0 ? (dailySent / p.dailyLimit) * 100 : 0,

        cycle_used: api.cycle_used || 0,
        cycle_max: api.cycle_max || 0,
        cycle_remaining: Number.isFinite(m.monthlyRemaining)
          ? m.monthlyRemaining
          : (api.cycle_remaining ?? 0),
        cycle_percent: api.cycle_percent || 0,

        total_emails: api.total_emails || 0,
        hard_bounces: api.hard_bounces || 0,
        soft_bounces: api.soft_bounces || 0,
        bounce_percent: api.bounce_percent || 0,
        spam_count: api.spam_count || 0,
        spam_percent: api.spam_percent || 0,

        cooldown_until:
          p.cooldownUntil > now
            ? new Date(p.cooldownUntil).toISOString()
            : null,
      };
    }
    // Stable alphabetical ordering
    return Object.keys(out)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = out[key];
        return sorted;
      }, {});
  }
}
