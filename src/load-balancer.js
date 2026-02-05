import { getProvider, getProviderCount } from "./config-loader.js";

export class LoadBalancer {
  constructor(config, statsManager) {
    this.config = config;
    this.statsManager = statsManager;
    this.currentIndex = 0;
    this.providerCount = getProviderCount(config);

    if (this.providerCount === 0) {
      throw new Error("No providers configured");
    }
  }

  getNextProvider() {
    // Try to get best provider from stats manager (if in smtp2go mode)
    if (this.statsManager) {
      const bestName = this.statsManager.getBestProvider();
      if (bestName) {
        const provider = this.getProviderByName(bestName);
        if (provider) {
          return provider;
        }
      }
    }

    // Fallback to Round Robin
    const provider = getProvider(this.config, this.currentIndex);

    // Move to next provider
    this.currentIndex = (this.currentIndex + 1) % this.providerCount;

    return provider;
  }

  getCurrentIndex() {
    return this.currentIndex;
  }

  reset() {
    this.currentIndex = 0;
  }

  getProviderCount() {
    return this.providerCount;
  }

  getProviderByName(providerName) {
    return this.config.providers.find((p) => p.name === providerName) || null;
  }

  /**
   * Peek at the next N providers that would be selected without advancing the index.
   * In smtp2go mode, returns providers sorted by remaining quota (best first).
   * In generic mode, returns round-robin sequence from current position.
   */
  peekNextProviders(count = 5) {
    const result = [];

    // Check if we're in smtp2go mode
    if (this.statsManager) {
      const bestName = this.statsManager.getBestProvider();
      if (bestName) {
        // SMTP2GO mode: Get all providers sorted by remaining quota
        const sortedProviders = this.statsManager.getProvidersSortedByQuota();
        for (let i = 0; i < count && i < sortedProviders.length; i++) {
          result.push(sortedProviders[i % sortedProviders.length]);
        }
        // If we got providers, return them
        if (result.length > 0) {
          return result;
        }
      }
    }

    // Generic mode (Round Robin): simulate next N selections
    let tempIndex = this.currentIndex;
    for (let i = 0; i < count; i++) {
      const provider = getProvider(this.config, tempIndex);
      result.push(provider.name);
      tempIndex = (tempIndex + 1) % this.providerCount;
    }

    return result;
  }

  getAllProviders() {
    return this.config.providers;
  }
}
