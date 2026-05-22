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

  incrementError(providerName, error) {
    this.provider.incrementError(providerName, error);
  }

  async getStats() {
    return this.provider.getStats();
  }

  getBestProvider() {
    return this.provider.getBestProvider();
  }

  getRankedProviders() {
    if (typeof this.provider.getRankedProviders === "function") {
      return this.provider.getRankedProviders();
    }
    return this.config.providers.map((p) => p.name);
  }

  releaseReservation(providerName) {
    if (typeof this.provider.releaseReservation === "function") {
      this.provider.releaseReservation(providerName);
    }
  }
}
