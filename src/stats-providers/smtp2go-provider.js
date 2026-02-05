import axios from "axios";
import { BaseStatsProvider } from "./base-provider.js";

/**
 * SMTP2GO stats provider that polls the SMTP2GO API for usage metrics.
 * Implements smart load balancing based on remaining email quota.
 */
export class Smtp2goStatsProvider extends BaseStatsProvider {
  constructor(config, logger) {
    super(config, logger);

    // Cache for SMTP2GO API data
    this.cache = {
      timestamp: 0,
      data: {}, // providerName -> stats
    };

    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Validate that all providers have API keys
    config.providers.forEach((p) => {
      if (!p.api_key) {
        throw new Error(
          `Provider "${p.name}" missing "api_key" (required for smtp2go mode)`,
        );
      }
    });
  }

  incrementSent(providerName) {
    // SMTP2GO mode relies on API data, but we can track this for fallback
    // (keeping it minimal since API is source of truth)
  }

  incrementError(providerName) {
    // SMTP2GO mode relies on API data
  }

  async getStats() {
    const now = Date.now();
    if (
      now - this.cache.timestamp < this.CACHE_TTL &&
      Object.keys(this.cache.data).length > 0
    ) {
      return this.cache.data;
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

    this.cache.data = stats;
    this.cache.timestamp = now;

    return stats;
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
    // Find provider with most remaining emails
    let bestProvider = null;
    let maxRemaining = -1;

    for (const [name, data] of Object.entries(this.cache.data)) {
      if (data.error) continue;

      // Check cycle_remaining
      if (typeof data.cycle_remaining === "number") {
        if (data.cycle_remaining > maxRemaining) {
          maxRemaining = data.cycle_remaining;
          bestProvider = name;
        }
      }
    }

    return bestProvider;
  }
}
