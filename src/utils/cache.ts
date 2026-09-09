import type { ToolCacheConfig, CacheStats, ToolCallResult } from '../types.js';

interface CacheEntry {
  result: ToolCallResult;
  expiresAt: number;
}

/**
 * Recursively serializes any JavaScript value into a stable, deterministic JSON string
 * where object keys are alphabetically sorted at all levels.
 */
export function stableSerialize(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableSerialize(v)).join(',') + ']';
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + stableSerialize(value[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * In-memory response cache for tool executions.
 * Supports configurable TTLs, LRU eviction, deterministic argument hashing,
 * and selective prefix-based invalidation.
 */
export class ToolCacheManager {
  private entries = new Map<string, CacheEntry>();
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };

  /**
   * Generates a deterministic cache key for a tool and its arguments.
   */
  generateKey(toolName: string, args: Record<string, any> = {}, config?: ToolCacheConfig): string {
    if (config?.keyGenerator) {
      return `tool:${toolName}:${config.keyGenerator(args)}`;
    }
    return `tool:${toolName}:${stableSerialize(args)}`;
  }

  /**
   * Retrieves a cached result if present and unexpired.
   */
  get(toolName: string, args: Record<string, any> = {}, config?: ToolCacheConfig): ToolCallResult | undefined {
    const key = this.generateKey(toolName, args, config);
    const entry = this.entries.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update LRU by re-inserting
    this.entries.delete(key);
    this.entries.set(key, entry);

    this.stats.hits++;
    return entry.result;
  }

  /**
   * Caches a successful tool invocation result.
   */
  set(
    toolName: string,
    args: Record<string, any> = {},
    result: ToolCallResult,
    config?: ToolCacheConfig
  ): void {
    const ttlMs = config?.ttlMs ?? 60_000;
    const maxSize = config?.maxSize ?? 100;
    const key = this.generateKey(toolName, args, config);

    // If key exists, delete it first to reset position in Map
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    // Evict oldest entry if capacity reached
    while (this.entries.size >= maxSize && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    this.entries.set(key, {
      result,
      expiresAt: Date.now() + ttlMs
    });
  }

  /**
   * Clears cache entries.
   * If toolName is provided, clears entries for that tool only.
   * If omitted, clears all cached entries across all tools.
   * Returns the count of cleared entries.
   */
  clear(toolName?: string): number {
    if (!toolName) {
      const count = this.entries.size;
      this.entries.clear();
      return count;
    }

    const prefix = `tool:${toolName}:`;
    let count = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Returns current cache statistics.
   */
  getStats(): CacheStats {
    return {
      size: this.entries.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions
    };
  }

  /**
   * Resets hit/miss/eviction counters.
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }
}
