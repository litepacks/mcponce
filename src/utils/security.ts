import type { AuthIdentity, RateLimitConfig } from '../types.js';

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory sliding window rate limiter for DDoS and query loop defense.
 */
export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private max: number;
  private windowMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RateLimitConfig) {
    this.max = config.max > 0 ? config.max : 100;
    this.windowMs = (config.windowMs && config.windowMs > 0) ? config.windowMs : 60000;

    // Periodic sweep of expired windows every minute
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => this.cleanup(), Math.min(this.windowMs, 60000));
      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Checks whether an identifier (e.g. IP or API key) has exceeded the rate limit.
   */
  check(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 1,
        resetAt: now + this.windowMs
      };
      this.entries.set(key, entry);
      return {
        allowed: true,
        remaining: this.max - 1,
        resetMs: this.windowMs
      };
    }

    entry.count++;
    const remaining = Math.max(0, this.max - entry.count);
    const resetMs = Math.max(0, entry.resetAt - now);

    return {
      allowed: entry.count <= this.max,
      remaining,
      resetMs
    };
  }

  reset(): void {
    this.entries.clear();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.entries.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }
}

/**
 * Extracts Bearer token or API key from request headers or query string.
 */
export function extractAuthToken(
  headers: Record<string, string | undefined>,
  queryToken?: string
): string | undefined {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
    return authHeader.trim();
  }

  const apiKeyHeader = headers['x-api-key'] || headers['X-API-Key'];
  if (apiKeyHeader) {
    return apiKeyHeader.trim();
  }

  if (queryToken && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

  return undefined;
}

/**
 * Verifies whether the authenticated identity contains all required permission scopes.
 */
export function verifyToolScopes(
  requiredScopes?: string[],
  identityScopes?: string[]
): boolean {
  if (!requiredScopes || requiredScopes.length === 0) {
    return true;
  }
  if (!identityScopes || identityScopes.length === 0) {
    return false;
  }

  // Check wildcard or exact match
  if (identityScopes.includes('*') || identityScopes.includes('admin')) {
    return true;
  }

  return requiredScopes.every((required) => {
    return identityScopes.some((scope) => {
      if (scope === required) return true;
      if (scope.endsWith(':*')) {
        const prefix = scope.slice(0, -1);
        return required.startsWith(prefix);
      }
      return false;
    });
  });
}
