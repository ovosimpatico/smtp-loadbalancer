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
   * @param {Error}  [error]      - The delivery error (used for cooldown logic)
   */
  incrementError(providerName, error) {
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
   * Select the best provider for the next delivery. Implementations that
   * track quota may "reserve" the slot (count it as in-flight) here.
   * @returns {string|null} Provider name, or null to fall back / signal "none".
   */
  getBestProvider() {
    throw new Error("getBestProvider() must be implemented by subclass");
  }

  /**
   * Read-only ranking of eligible providers (best first). Does NOT reserve.
   * @returns {string[]}
   */
  getRankedProviders() {
    return [];
  }
}
