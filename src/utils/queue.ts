/**
 * Concurrency Limiter & FIFO Queue Manager for tool executions.
 *
 * Supports:
 * - Server-level sequential execution (FIFO queue, concurrency: 1).
 * - Per-tool sequential execution (concurrency: 1).
 * - Named mutex queues shared across multiple tools (e.g. sequential: "browser").
 * - Dynamic maxConcurrency limits.
 * - Non-blocking AbortSignal cancellation while waiting in queue.
 * - Re-entrant safe execution for inter-tool invocations.
 */

export interface QueueItem {
  resolve: () => void;
  reject: (err: any) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class ConcurrencyQueue {
  private running = 0;
  private queue: QueueItem[] = [];

  constructor(public readonly maxConcurrency: number = 1) {
    if (maxConcurrency < 1) {
      throw new Error('maxConcurrency must be at least 1');
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }

  /**
   * Acquires a slot in the concurrency queue.
   * If slot is open, returns release function immediately.
   * If saturated, waits in FIFO queue.
   * If signal is cancelled while waiting, promptly dequeues and rejects.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Operation was cancelled before starting');
    }

    if (this.running < this.maxConcurrency) {
      this.running++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;

      const item: QueueItem = {
        resolve: () => {
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          this.running++;
          let released = false;
          resolve(() => {
            if (!released) {
              released = true;
              this.release();
            }
          });
        },
        reject: (err: any) => {
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          reject(err);
        },
        signal
      };

      if (signal) {
        abortHandler = () => {
          const index = this.queue.indexOf(item);
          if (index !== -1) {
            this.queue.splice(index, 1);
            item.reject(signal.reason || new Error('Operation was cancelled while waiting in queue'));
          }
        };
        item.abortHandler = abortHandler;
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.queue.push(item);
    });
  }

  /**
   * Runs a task function within the queue.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private release(): void {
    this.running--;
    while (this.queue.length > 0 && this.running < this.maxConcurrency) {
      const next = this.queue.shift();
      if (next) {
        if (next.signal?.aborted) {
          continue; // Already rejected by abort listener
        }
        next.resolve();
        break;
      }
    }
  }
}

/**
 * Manages multiple named concurrency queues.
 */
export class QueueManager {
  private queues = new Map<string, ConcurrencyQueue>();

  getQueue(key: string, maxConcurrency = 1): ConcurrencyQueue {
    let q = this.queues.get(key);
    if (!q) {
      q = new ConcurrencyQueue(maxConcurrency);
      this.queues.set(key, q);
    }
    return q;
  }

  getStats(): Record<string, { active: number; pending: number; maxConcurrency: number }> {
    const stats: Record<string, { active: number; pending: number; maxConcurrency: number }> = {};
    for (const [k, q] of this.queues.entries()) {
      stats[k] = { active: q.active, pending: q.pending, maxConcurrency: q.maxConcurrency };
    }
    return stats;
  }

  clear(): void {
    this.queues.clear();
  }
}
