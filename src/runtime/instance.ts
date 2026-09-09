import type { ResolvedConfig } from './config.js';
import type { RuntimeState } from '../types.js';
import { LockManager } from './lock.js';
import { StateManager } from './state.js';
import { checkHealth, isPidRunning } from './health.js';
import type { Logger } from '../types.js';

export type InstanceRole =
  | {
      role: 'owner';
      lockManager: LockManager;
      stateManager: StateManager;
    }
  | {
      role: 'bridge';
      state: RuntimeState;
      lockManager: LockManager;
      stateManager: StateManager;
    };

export interface EnsureInstanceOptions {
  noSingleton?: boolean;
  maxWaitMs?: number;
  initialRetryDelayMs?: number;
  logger?: Logger;
}

export class InstanceCoordinator {
  readonly lockManager: LockManager;
  readonly stateManager: StateManager;
  private config: ResolvedConfig<any>;

  constructor(config: ResolvedConfig<any>) {
    this.config = config;
    this.lockManager = new LockManager(config.dataDir);
    this.stateManager = new StateManager(config.dataDir);
  }

  /**
   * Resolves the instance role: either 'owner' (this process starts HTTP server)
   * or 'bridge' (this process connects to an existing verified healthy HTTP server).
   */
  async ensureInstance(options: EnsureInstanceOptions = {}): Promise<InstanceRole> {
    const {
      noSingleton = false,
      maxWaitMs = 4000,
      initialRetryDelayMs = 25,
      logger
    } = options;

    if (noSingleton) {
      return {
        role: 'owner',
        lockManager: this.lockManager,
        stateManager: this.stateManager
      };
    }

    // Step 1: Check existing runtime state
    const existingState = this.stateManager.read();
    if (existingState && existingState.name === this.config.name) {
      const health = await checkHealth(existingState.host, existingState.port, this.config.name, 200);
      if (health) {
        logger?.debug('Existing healthy instance discovered', {
          pid: existingState.pid,
          port: existingState.port
        });
        return {
          role: 'bridge',
          state: existingState,
          lockManager: this.lockManager,
          stateManager: this.stateManager
        };
      }

      // Health check failed for recorded runtime state. Check if PID is alive.
      if (!isPidRunning(existingState.pid)) {
        logger?.warn('Stale runtime state detected (process not running), recovering', {
          stalePid: existingState.pid,
          stalePort: existingState.port
        });
        this.lockManager.forceRelease();
        this.stateManager.forceClean();
      }
    }

    // Step 2: Attempt to acquire the atomic lock
    if (this.lockManager.tryAcquire(this.config.name)) {
      logger?.debug('Acquired server lock, becoming instance owner', { pid: process.pid });
      return {
        role: 'owner',
        lockManager: this.lockManager,
        stateManager: this.stateManager
      };
    }

    // Fast-path recovery: If lock file exists but has no valid metadata (corrupt/empty)
    // or the lock holder PID is already dead, recover immediately without waiting maxWaitMs.
    const initialLock = this.lockManager.readLock();
    if (!initialLock || !isPidRunning(initialLock.pid)) {
      logger?.warn('Detected dead lock holder or corrupted lock on startup, immediately claiming ownership', {
        lockPid: initialLock?.pid
      });
      this.lockManager.forceRelease();
      this.stateManager.forceClean();

      if (this.lockManager.tryAcquire(this.config.name)) {
        return {
          role: 'owner',
          lockManager: this.lockManager,
          stateManager: this.stateManager
        };
      }
    }

    // Step 3: Lock acquisition failed -> Another live process is holding the lock or starting up.
    // Wait and retry discovery with backoff.
    const startTime = Date.now();
    let delay = initialRetryDelayMs;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 300);

      // Check runtime state again
      const state = this.stateManager.read();
      if (state && state.name === this.config.name) {
        const health = await checkHealth(state.host, state.port, this.config.name, 200);
        if (health) {
          logger?.debug('Discovered healthy instance during race retry', {
            pid: state.pid,
            port: state.port
          });
          return {
            role: 'bridge',
            state,
            lockManager: this.lockManager,
            stateManager: this.stateManager
          };
        }
      }

      // If lock holder PID is dead, break early to recover
      const lockData = this.lockManager.readLock();
      if (!lockData || !isPidRunning(lockData.pid)) {
        logger?.warn('Detected crashed or corrupt lock holder during wait, breaking to recover', {
          crashedPid: lockData?.pid
        });
        break;
      }
    }

    // Step 4: Stale recovery after timeout or dead lock-holder detection
    const lockData = this.lockManager.readLock();
    const currentState = this.stateManager.read();
    const isHealthy = currentState
      ? await checkHealth(currentState.host, currentState.port, this.config.name, 500)
      : null;

    if (!isHealthy) {
      logger?.warn('Server is unreachable or stale, forcing stale recovery and claiming ownership');
      this.lockManager.forceRelease();
      this.stateManager.forceClean();

      if (this.lockManager.tryAcquire(this.config.name)) {
        return {
          role: 'owner',
          lockManager: this.lockManager,
          stateManager: this.stateManager
        };
      }
    }

    // Another process may have won the stale recovery race; wait briefly to discover its healthy server
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const finalState = this.stateManager.read();
      if (finalState && finalState.name === this.config.name) {
        const health = await checkHealth(finalState.host, finalState.port, this.config.name, 500);
        if (health) {
          return {
            role: 'bridge',
            state: finalState,
            lockManager: this.lockManager,
            stateManager: this.stateManager
          };
        }
      }
    }

    throw new Error(
      `Failed to acquire server lock or discover healthy server for "${this.config.name}" after ${maxWaitMs}ms`
    );
  }
}
