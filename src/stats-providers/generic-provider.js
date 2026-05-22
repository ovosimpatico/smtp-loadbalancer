import { BaseStatsProvider } from "./base-provider.js";

/**
 * Generic stats provider that maintains internal counters.
 * Uses round-robin load balancing (returns null from getBestProvider, which
 * tells the LoadBalancer to use its own round-robin rotation).
 */
export class GenericStatsProvider extends BaseStatsProvider {
  constructor(config, logger) {
    super(config, logger);

    // Internal counters for each provider
    this.counters = new Map();
    config.providers.forEach((p) => {
      this.counters.set(p.name, { sent: 0, errors: 0 });
    });
  }

  incrementSent(providerName) {
    const stats = this.counters.get(providerName);
    if (stats) stats.sent++;
  }

  incrementError(providerName) {
    const stats = this.counters.get(providerName);
    if (stats) stats.errors++;
  }

  async getStats() {
    const stats = {};
    for (const [name, counter] of this.counters) {
      stats[name] = { type: "generic", status: "ok", ...counter };
    }
    // Sort alphabetically by key for stable output
    return Object.keys(stats)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = stats[key];
        return sorted;
      }, {});
  }

  getBestProvider() {
    // Returning null tells the LoadBalancer to use round-robin.
    return null;
  }
}
