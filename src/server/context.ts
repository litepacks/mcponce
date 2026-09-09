import type { Logger } from '../types.js';

export class ContextManager<TContext = unknown> {
  private factory?: () => Promise<TContext> | TContext;
  private cachedContext?: TContext;
  private initialized = false;
  private initializingPromise?: Promise<TContext>;

  constructor(factory?: () => Promise<TContext> | TContext) {
    this.factory = factory;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(logger?: Logger): Promise<TContext> {
    if (this.initialized) {
      return this.cachedContext as TContext;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = (async () => {
      try {
        if (this.factory) {
          logger?.debug('Initializing shared application context');
          this.cachedContext = await this.factory();
        } else {
          this.cachedContext = {} as TContext;
        }
        this.initialized = true;
        logger?.info('Shared application context successfully initialized');
        return this.cachedContext;
      } catch (err: any) {
        logger?.error('Failed to initialize shared application context', {
          error: err.message || String(err),
          stack: err.stack
        });
        throw new Error(
          `Application context initialization failed: ${err.message || String(err)}`
        );
      } finally {
        this.initializingPromise = undefined;
      }
    })();

    return this.initializingPromise;
  }

  getContext(): TContext {
    if (!this.initialized && this.factory) {
      throw new Error('Context requested before initialization was completed');
    }
    return this.cachedContext as TContext;
  }
}
