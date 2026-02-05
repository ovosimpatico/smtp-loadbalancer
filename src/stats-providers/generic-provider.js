import { BaseStatsProvider } from "./base-provider.js";

/**
 * Generic stats provider that maintains internal counters.
 * Uses Round Robin load balancing (returns null from getBestProvider).
 */
export class GenericStatsProvider extends BaseStatsProvider {
  constructor(config, logger) {
    super(config, logger);

    // Internal counters for each provider
    this.counters = new Map();

    // Initialize counters for all providers
    config.providers.forEach((p) => {
      this.counters.set(p.name, {
        sent: 0,
        errors: 0,
      });
    });
  }

  incrementSent(providerName) {
    const stats = this.counters.get(providerName);
    if (stats) {
      stats.sent++;
    }
  }

  incrementError(providerName) {
    const stats = this.counters.get(providerName);
    if (stats) {
      stats.errors++;
    }
  }

  async getStats() {
    const stats = {};
    for (const [name, counter] of this.counters) {
      stats[name] = {
        type: "generic",
        ...counter,
      };
    }
    return stats;
  }

  getBestProvider() {
    // Return null to use Round Robin load balancing
    return null;
  }
}
