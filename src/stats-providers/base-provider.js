/**
 * Base class for stats providers.
 * All stats providers should extend this class and implement its methods.
 */
export class BaseStatsProvider {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Increment sent counter for a provider.
   * @param {string} providerName - Name of the provider
   */
  incrementSent(providerName) {
    throw new Error("incrementSent() must be implemented by subclass");
  }

  /**
   * Increment error counter for a provider.
   * @param {string} providerName - Name of the provider
   */
  incrementError(providerName) {
    throw new Error("incrementError() must be implemented by subclass");
  }

  /**
   * Get statistics for all providers.
   * @returns {Promise<Object>} Stats object with provider data
   */
  async getStats() {
    throw new Error("getStats() must be implemented by subclass");
  }

  /**
   * Get the best provider for load balancing.
   * @returns {string|null} Provider name or null to use default Round Robin
   */
  getBestProvider() {
    throw new Error("getBestProvider() must be implemented by subclass");
  }
}
