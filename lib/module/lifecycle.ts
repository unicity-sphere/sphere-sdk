/**
 * lib/module/lifecycle — module load/destroy gate primitive.
 *
 * Every module currently repeats a variation of:
 *   private loadedPromise?: Promise<void>;
 *   private loaded = false;
 *   private destroyed = false;
 *   private ensureInitialized() { ... }
 *   async load() { if (this.loaded) return; ... }
 *   async destroy() { this.destroyed = true; ... }
 *
 * This helper centralizes the deferred-load gate. Modules embed a
 * `ModuleLifecycle` instance rather than inheriting so we don't fight
 * TypeScript-class semantics (private fields, decorators, etc.).
 */

export class ModuleLifecycle {
  private _loaded = false;
  private _destroyed = false;
  private _loadPromise?: Promise<void>;
  private _initialized = false;
  private _readyResolvers: Array<() => void> = [];

  markInitialized(): void {
    this._initialized = true;
  }

  markDestroyed(): void {
    this._destroyed = true;
    // Resolve any awaiters so they don't hang forever
    for (const r of this._readyResolvers) r();
    this._readyResolvers = [];
  }

  /**
   * Coalesce concurrent load() calls onto a single promise. If load has
   * already succeeded, resolve immediately.
   */
  async load(runner: () => Promise<void>): Promise<void> {
    if (this._loaded) return;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      await runner();
      this._loaded = true;
      // Wake ready waiters
      for (const r of this._readyResolvers) r();
      this._readyResolvers = [];
    })();
    try {
      await this._loadPromise;
    } catch (err) {
      // Reset so a subsequent load() call can retry.
      this._loadPromise = undefined;
      throw err;
    }
  }

  /**
   * Wait until either `load()` completes or the module is destroyed.
   * Returns immediately if already loaded/destroyed.
   */
  async waitForReady(): Promise<void> {
    if (this._loaded || this._destroyed) return;
    return new Promise<void>((resolve) => {
      this._readyResolvers.push(resolve);
    });
  }

  ensureInitialized(moduleName = 'Module'): void {
    if (!this._initialized) {
      throw new Error(`${moduleName} not initialized. Call initialize(deps) first.`);
    }
  }

  ensureNotDestroyed(moduleName = 'Module'): void {
    if (this._destroyed) {
      throw new Error(`${moduleName} has been destroyed.`);
    }
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  get isDestroyed(): boolean {
    return this._destroyed;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }
}
