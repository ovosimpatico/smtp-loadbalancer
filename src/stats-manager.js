import { GenericStatsProvider } from "./stats-providers/generic-provider.js";
import { Smtp2goStatsProvider } from "./stats-providers/smtp2go-provider.js";

/**
 * StatsManager - Lightweight coordinator that delegates to provider implementations.
 * Instantiates the correct provider based on config.mode.
 */
export class StatsManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.mode = config.mode || "generic";

    // Instantiate the appropriate provider
    this.provider = this._createProvider();

    this.logger.info(`Stats provider initialized: ${this.mode}`);
  }

  _createProvider() {
    switch (this.mode) {
      case "generic":
        return new GenericStatsProvider(this.config, this.logger);

      case "smtp2go":
        return new Smtp2goStatsProvider(this.config, this.logger);

      default:
        throw new Error(`Unknown stats provider mode: ${this.mode}`);
    }
  }

  incrementSent(providerName) {
    this.provider.incrementSent(providerName);
  }

  incrementError(providerName) {
    this.provider.incrementError(providerName);
  }

  async getStats() {
    return await this.provider.getStats();
  }

  getBestProvider() {
    return this.provider.getBestProvider();
  }
}
