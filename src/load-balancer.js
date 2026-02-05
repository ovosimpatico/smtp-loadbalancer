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

  getAllProviders() {
    return this.config.providers;
  }
}
