import axios from "axios";
import { BaseStatsProvider } from "./base-provider.js";

/**
 * SMTP2GO stats provider that polls the SMTP2GO API for usage metrics.
 * Implements smart load balancing based on remaining email quota.
 * Tracks daily sent emails locally (SMTP2GO free accounts: 200/day limit).
 */
export class Smtp2goStatsProvider extends BaseStatsProvider {
  constructor(config, logger) {
    super(config, logger);

    // SMTP2GO free account limits
    this.DAILY_LIMIT = 200; // emails per day
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Cache for SMTP2GO API data
    this.cache = {
      timestamp: 0,
      data: {}, // providerName -> stats
    };

    // Daily counters (reset at midnight)
    this.dailyCounters = new Map();
    this.currentDate = this._getCurrentDate();

    // Initialize daily counters
    config.providers.forEach((p) => {
      this.dailyCounters.set(p.name, 0);

      if (!p.api_key) {
        throw new Error(
          `Provider "${p.name}" missing "api_key" (required for smtp2go mode)`,
        );
      }
    });
  }

  _getCurrentDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  _checkAndResetDailyCounters() {
    const today = this._getCurrentDate();
    if (today !== this.currentDate) {
      this.logger.info("Daily counters reset", { date: today });
      this.currentDate = today;
      // Reset all counters
      for (const [providerName] of this.dailyCounters) {
        this.dailyCounters.set(providerName, 0);
      }
    }
  }

  incrementSent(providerName) {
    this._checkAndResetDailyCounters();
    const current = this.dailyCounters.get(providerName) || 0;
    this.dailyCounters.set(providerName, current + 1);
    this.logger.debug(
      `Daily counter for ${providerName}: ${current + 1}/${this.DAILY_LIMIT}`,
    );
  }

  incrementError(providerName) {
    // Errors don't count towards daily limit
  }

  async getStats() {
    this._checkAndResetDailyCounters();

    const now = Date.now();
    if (
      now - this.cache.timestamp < this.CACHE_TTL &&
      Object.keys(this.cache.data).length > 0
    ) {
      // Return cached data with current daily counters
      return this._addDailyCountersToStats(this.cache.data);
    }

    this.logger.info("Refreshing SMTP2GO stats...");
    const stats = {};

    // Parallel fetch for all providers
    const promises = this.config.providers.map(async (provider) => {
      try {
        if (!provider.api_key) {
          stats[provider.name] = { error: "No API key configured" };
          return;
        }

        const data = await this._fetchProviderStats(provider.api_key);
        stats[provider.name] = data;
      } catch (error) {
        this.logger.error(`Failed to fetch stats for ${provider.name}`, {
          error: error.message,
        });
        stats[provider.name] = { error: error.message };
      }
    });

    await Promise.all(promises);

    // Sort alphabetically by key
    const sortedStats = Object.keys(stats)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = stats[key];
        return sorted;
      }, {});

    this.cache.data = sortedStats;
    this.cache.timestamp = now;

    return this._addDailyCountersToStats(sortedStats);
  }

  _addDailyCountersToStats(stats) {
    const result = {};
    for (const [name, data] of Object.entries(stats)) {
      const dailySent = this.dailyCounters.get(name) || 0;
      const dailyRemaining = Math.max(0, this.DAILY_LIMIT - dailySent);

      result[name] = {
        ...data,
        daily_sent: dailySent,
        daily_limit: this.DAILY_LIMIT,
        daily_remaining: dailyRemaining,
        daily_percent: (dailySent / this.DAILY_LIMIT) * 100,
      };
    }
    return result;
  }

  async _fetchProviderStats(apiKey) {
    const baseUrl = "https://api.smtp2go.com/v3";
    const headers = {
      "Content-Type": "application/json",
      "X-Smtp2go-Api-Key": apiKey,
    };

    try {
      // Fetch summary and cycle data
      const [summaryRes, cycleRes] = await Promise.all([
        axios.post(`${baseUrl}/stats/email_summary`, {}, { headers }),
        axios.post(`${baseUrl}/stats/email_cycle`, {}, { headers }),
      ]);

      const summary = summaryRes.data.data;
      const cycle = cycleRes.data.data;

      return {
        type: "smtp2go",
        total_emails: summary.email_count || 0,
        cycle_used: cycle.cycle_used || 0,
        cycle_max: cycle.cycle_max || 0,
        cycle_remaining: cycle.cycle_remaining || 0,
        cycle_percent:
          cycle.cycle_max > 0 ? (cycle.cycle_used / cycle.cycle_max) * 100 : 0,
      };
    } catch (error) {
      throw error;
    }
  }

  getBestProvider() {
    this._checkAndResetDailyCounters();

    // Find provider with most EFFECTIVE remaining (min of daily and monthly)
    let bestProvider = null;
    let maxEffectiveRemaining = -1;

    for (const [name, data] of Object.entries(this.cache.data)) {
      if (data.error) continue;

      const dailySent = this.dailyCounters.get(name) || 0;
      const dailyRemaining = Math.max(0, this.DAILY_LIMIT - dailySent);
      const monthlyRemaining = data.cycle_remaining || 0;

      // Effective remaining is the minimum of daily and monthly
      const effectiveRemaining = Math.min(dailyRemaining, monthlyRemaining);

      // Skip providers that have hit their daily limit
      if (dailyRemaining === 0) continue;

      if (effectiveRemaining > maxEffectiveRemaining) {
        maxEffectiveRemaining = effectiveRemaining;
        bestProvider = name;
      }
    }

    return bestProvider;
  }

  getProvidersSortedByQuota() {
    this._checkAndResetDailyCounters();

    // Return providers sorted by EFFECTIVE remaining quota (descending)
    const providers = [];

    for (const [name, data] of Object.entries(this.cache.data)) {
      if (data.error) continue;

      const dailySent = this.dailyCounters.get(name) || 0;
      const dailyRemaining = Math.max(0, this.DAILY_LIMIT - dailySent);
      const monthlyRemaining = data.cycle_remaining || 0;

      // Effective remaining is the minimum of daily and monthly
      const effectiveRemaining = Math.min(dailyRemaining, monthlyRemaining);

      // Skip providers that have hit their daily limit
      if (dailyRemaining > 0) {
        providers.push({ name, remaining: effectiveRemaining });
      }
    }

    // Sort by effective remaining quota descending
    providers.sort((a, b) => b.remaining - a.remaining);

    return providers.map((p) => p.name);
  }
}
