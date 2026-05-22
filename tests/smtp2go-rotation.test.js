import test from "node:test";
import assert from "node:assert/strict";
import {
  Smtp2goStatsProvider,
  isRateLimitError,
} from "../src/stats-providers/smtp2go-provider.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeProvider(count = 3, smtp2go = { dailyReserveRatio: 0 }) {
  const config = {
    mode: "smtp2go",
    providers: Array.from({ length: count }, (_, i) => ({
      name: `P${i + 1}`,
      api_key: `key-${i}`,
      host: "h",
      port: 465,
      secure: true,
      auth: { user: "u", pass: "p" },
      from: "a@b.com",
      daily_limit: 200,
    })),
    smtp2go,
  };
  const provider = new Smtp2goStatsProvider(config, logger);
  // Reset any state restored from disk so tests are deterministic.
  for (const p of provider.providers.values()) {
    p.dailyCounter = 0;
    p.sinceRefresh = 0;
    p.inFlight = 0;
  }
  return provider;
}

// Warm the API cache with a generous monthly quota for every provider.
function warmCache(provider, cycleRemaining = 100000) {
  const data = {};
  for (const name of provider.providers.keys()) {
    data[name] = {
      type: "smtp2go",
      cycle_remaining: cycleRemaining,
      cycle_used: 0,
      daily_api_count: 0,
    };
  }
  provider.cache.data = data;
  provider.cache.timestamp = Date.now();
}

test("ranks all providers as available when fresh", () => {
  const p = makeProvider(3);
  warmCache(p);
  assert.deepEqual(p.getRankedProviders().sort(), ["P1", "P2", "P3"]);
});

test("getBestProvider reserves an in-flight slot", () => {
  const p = makeProvider(3);
  warmCache(p);
  const picked = p.getBestProvider();
  assert.ok(picked);
  assert.equal(p.providers.get(picked).inFlight, 1);
});

test("spreads load evenly across providers", () => {
  const p = makeProvider(3);
  warmCache(p);
  const counts = { P1: 0, P2: 0, P3: 0 };
  for (let i = 0; i < 9; i++) {
    const picked = p.getBestProvider();
    counts[picked]++;
    // Simulate the delivery completing successfully.
    p.incrementSent(picked);
  }
  assert.deepEqual(counts, { P1: 3, P2: 3, P3: 3 });
});

test("excludes a provider that hit its daily limit", () => {
  const p = makeProvider(3);
  warmCache(p);
  p.providers.get("P1").dailyCounter = 200;
  const ranked = p.getRankedProviders();
  assert.ok(!ranked.includes("P1"));
  assert.equal(ranked.length, 2);
});

test("returns null when every provider is exhausted", () => {
  const p = makeProvider(2);
  warmCache(p);
  for (const prov of p.providers.values()) prov.dailyCounter = 200;
  assert.equal(p.getBestProvider(), null);
});

test("effective remaining is limited by the monthly cycle", () => {
  const p = makeProvider(2);
  warmCache(p, 5); // only 5 left in the monthly cycle
  const m = p._metrics(p.providers.get("P1"));
  assert.equal(m.effectiveRemaining, 5);
});

test("a rate-limit error puts the provider in cooldown", () => {
  const p = makeProvider(3);
  warmCache(p);
  p.incrementError("P1", { responseCode: 421 });
  assert.ok(!p.getRankedProviders().includes("P1"));
});

test("three consecutive errors trigger cooldown", () => {
  const p = makeProvider(3);
  warmCache(p);
  for (let i = 0; i < 3; i++) p.incrementError("P2", new Error("timeout"));
  assert.ok(!p.getRankedProviders().includes("P2"));
});

test("daily reserve ratio lowers the effective limit", () => {
  const p = makeProvider(1, { dailyReserveRatio: 0.1 });
  warmCache(p);
  const m = p._metrics(p.providers.get("P1"));
  assert.equal(m.effectiveDailyLimit, 180); // floor(200 * 0.9)
});

test("the short-term rate cap excludes a provider", () => {
  const p = makeProvider(2, { dailyReserveRatio: 0, rateLimit: { maxPerMinute: 2 } });
  warmCache(p);
  const now = Date.now();
  p.providers.get("P1").sendTimes = [now, now];
  assert.ok(!p.getRankedProviders().includes("P1"));
  assert.ok(p.getRankedProviders().includes("P2"));
});

test("isRateLimitError detects throttling signals", () => {
  assert.equal(isRateLimitError({ responseCode: 421 }), true);
  assert.equal(isRateLimitError({ message: "Too many requests" }), true);
  assert.equal(isRateLimitError({ message: "rate limit exceeded" }), true);
  assert.equal(isRateLimitError({ responseCode: 550 }), false);
  assert.equal(isRateLimitError(null), false);
});
