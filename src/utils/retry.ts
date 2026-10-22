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
 * Parses a Retry-After header or property value (integer seconds, float seconds, or HTTP date string)
 * into milliseconds relative to now.
 */
export function parseRetryAfterValue(value: string | number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 1000);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Numeric seconds (e.g. "5" or "2.5")
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric) && numeric >= 0) {
    return Math.round(numeric * 1000);
  }

  // HTTP date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return Math.max(0, diff);
  }

  return null;
}

/**
 * Extracts retry-after delay in milliseconds from an error object, checking:
 * 1. err.retryAfterMs (numeric milliseconds)
 * 2. err.retryAfter (numeric seconds or HTTP date string)
 * 3. err.response?.headers or err.headers (Headers instance or plain object)
 */
export function extractRetryAfterMs(err: any): number | null {
  if (!err || typeof err !== 'object') return null;

  // 1. Direct milliseconds property
  if (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs) && err.retryAfterMs >= 0) {
    return Math.round(err.retryAfterMs);
  }

  // 2. retryAfter property
  if (err.retryAfter !== undefined && err.retryAfter !== null) {
    const parsed = parseRetryAfterValue(err.retryAfter);
    if (parsed !== null) return parsed;
  }

  // 3. Headers inspection (err.response?.headers or err.headers)
  const headers = err.response?.headers ?? err.headers;
  if (headers) {
    let headerVal: any;
    if (typeof headers.get === 'function') {
      headerVal = headers.get('retry-after') || headers.get('Retry-After');
    } else if (typeof headers === 'object') {
      headerVal = headers['retry-after'] ?? headers['Retry-After'];
    }
    if (headerVal !== undefined && headerVal !== null) {
      const parsed = parseRetryAfterValue(headerVal);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * Computes backoff delay with optional randomized jitter to prevent thundering herd problems.
 * - If jitter is true: applies Equal Jitter (randomizes between 50% and 100% of calculated backoff).
 * - If jitter is a number (e.g. 0.2): applies proportional jitter (±20% around calculated backoff).
 * - If jitter is falsy: deterministic exponential backoff.
 */
export function computeBackoffDelay(
  attempt: number,
  baseBackoffMs: number,
  factor: number,
  maxBackoffMs: number,
  jitter?: boolean | number
): number {
  const calculated = Math.min(
    Math.round(baseBackoffMs * Math.pow(factor, Math.max(0, attempt - 1))),
    maxBackoffMs
  );

  if (!jitter) {
    return Math.max(0, calculated);
  }

  if (typeof jitter === 'number') {
    const ratio = Math.max(0, Math.min(1, Math.abs(jitter)));
    const min = calculated * (1 - ratio);
    const max = calculated * (1 + ratio);
    const randomized = min + Math.random() * (max - min);
    return Math.max(0, Math.min(Math.round(randomized), maxBackoffMs));
  }

  // Equal Jitter: calculated / 2 + Math.random() * (calculated / 2)
  const half = calculated / 2;
  const randomized = half + Math.random() * half;
  return Math.max(0, Math.min(Math.round(randomized), maxBackoffMs));
}

/**
 * Executes an asynchronous function with automatic exponential backoff retries.
 * Respects AbortSignal cancellations, custom error predicates, Retry-After headers, and randomized jitter.
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

  const rawAttempts = normalized.attempts ?? normalized.maxRetries ?? 0;
  const maxAttempts = Math.max(0, rawAttempts);
  if (maxAttempts === 0) {
    const result = await fn();
    return { result, retries: 0 };
  }

  const baseBackoffMs = normalized.backoffMs ?? normalized.initialDelayMs ?? 100;
  const factor = normalized.factor ?? normalized.backoffFactor ?? 2;
  const maxBackoffMs = normalized.maxBackoffMs ?? normalized.maxDelayMs ?? 5000;
  const retryIf = normalized.retryIf ?? normalized.retryableErrors;

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

      let delayMs: number;
      const retryAfterMs = normalized.respectRetryAfter !== false ? extractRetryAfterMs(err) : null;
      if (retryAfterMs !== null) {
        delayMs = Math.min(retryAfterMs, maxBackoffMs);
      } else {
        delayMs = computeBackoffDelay(
          attempt,
          baseBackoffMs,
          factor,
          maxBackoffMs,
          normalized.jitter
        );
      }

      onRetry?.(err, attempt, delayMs);

      await sleepWithSignal(delayMs, signal);
    }
  }
}
