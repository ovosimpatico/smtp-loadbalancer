/**
 * LoadBalancer selects which upstream provider handles each delivery.
 *
 *  - generic mode: plain round-robin across all providers.
 *  - smtp2go mode: delegates to the quota-aware StatsManager, which reserves
 *    a slot on the chosen provider. Returns null when every provider is
 *    exhausted / rate-limited / cooling down so the caller can back off.
 */
export class LoadBalancer {
  constructor(config, statsManager) {
    this.config = config;
    this.statsManager = statsManager;
    this.mode = config.mode || "generic";
    this.currentIndex = 0;
    this.providerCount = config.providers.length;

    if (this.providerCount === 0) {
      throw new Error("No providers configured");
    }
  }

  getNextProvider() {
    if (this.mode === "smtp2go") {
      const name = this.statsManager.getBestProvider();
      if (!name) return null; // all providers unavailable — caller retries
      return this.getProviderByName(name);
    }

    // Generic mode: round-robin
    const provider = this.config.providers[this.currentIndex];
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
   * Peek at the next N providers without advancing state.
   * smtp2go: ranked by remaining quota. generic: round-robin sequence.
   */
  peekNextProviders(count = 5) {
    if (this.mode === "smtp2go") {
      return this.statsManager.getRankedProviders().slice(0, count);
    }

    const result = [];
    let idx = this.currentIndex;
    for (let i = 0; i < count; i++) {
      result.push(this.config.providers[idx].name);
      idx = (idx + 1) % this.providerCount;
    }
    return result;
  }

  getAllProviders() {
    return this.config.providers;
  }
}
