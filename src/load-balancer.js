import { getProvider, getProviderCount } from './config-loader.js';

export class LoadBalancer {
  constructor(config) {
    this.config = config;
    this.currentIndex = 0;
    this.providerCount = getProviderCount(config);

    if (this.providerCount === 0) {
      throw new Error('No providers configured');
    }
  }

  getNextProvider() {
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
    return this.config.providers.find(p => p.name === providerName) || null;
  }

  getAllProviders() {
    return this.config.providers;
  }
}
