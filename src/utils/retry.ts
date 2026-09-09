import type { ToolRetryConfig } from '../types.js';

export interface ExecuteWithRetryOptions {
  name: string;
  config?: number | ToolRetryConfig | false;
  signal?: AbortSignal;
  onRetry?: (error: any, attempt: number, delayMs: number) => void;
}

/**
 * Returns a promise that resolves after the specified millisecond delay,
 * or rejects immediately if the AbortSignal is triggered.
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('Operation was cancelled'));
  }

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      cleanup();
      reject(signal?.reason || new Error('Operation was cancelled'));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Races a promise against an AbortSignal, rejecting promptly if the signal triggers
 * and safely removing event listeners upon promise completion to prevent dangling rejections.
 */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  createError?: () => Error
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason || createError?.() || new Error('Operation was cancelled'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason || createError?.() || new Error('Operation was cancelled'));
    };

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * Executes an asynchronous function with automatic exponential backoff retries.
 * Respects AbortSignal cancellations and custom error predicates.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: ExecuteWithRetryOptions
): Promise<{ result: T; retries: number }> {
  const { config, signal, onRetry } = options;

  if (config === false || config === undefined) {
    const result = await fn();
    return { result, retries: 0 };
  }

  const normalized: ToolRetryConfig =
    typeof config === 'number'
      ? { attempts: config }
      : config;

  const maxAttempts = Math.max(0, normalized.attempts);
  if (maxAttempts === 0) {
    const result = await fn();
    return { result, retries: 0 };
  }

  const baseBackoffMs = normalized.backoffMs ?? 100;
  const factor = normalized.factor ?? 2;
  const maxBackoffMs = normalized.maxBackoffMs ?? 5000;
  const retryIf = normalized.retryIf;

  let attempt = 0;

  while (true) {
    try {
      const result = await fn();
      return { result, retries: attempt };
    } catch (err: any) {
      if (typeof err === 'object' && err !== null) {
        try {
          (err as any).retries = attempt;
        } catch {}
      }

      // If signal is aborted (cancellation or tool timeout), abort retrying immediately
      if (signal?.aborted) {
        throw err;
      }

      // If retry attempts exhausted, throw
      if (attempt >= maxAttempts) {
        throw err;
      }

      // If custom retryIf predicate returns false, don't retry
      if (retryIf && !retryIf(err)) {
        throw err;
      }

      attempt++;
      const delayMs = Math.min(
        Math.round(baseBackoffMs * Math.pow(factor, attempt - 1)),
        maxBackoffMs
      );

      onRetry?.(err, attempt, delayMs);

      await sleepWithSignal(delayMs, signal);
    }
  }
}
