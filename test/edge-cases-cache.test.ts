import { describe, it, expect, beforeEach } from 'vitest';
import { stableSerialize, ToolCacheManager } from '../src/utils/cache.js';

describe('Edge Cases: Cache & Serialization Determinism', () => {
  describe('1. stableSerialize Deep Determinism', () => {
    it('produces identical serialized output regardless of object key insertion order', () => {
      const objA = {
        z: 100,
        a: 'hello',
        m: {
          subZ: false,
          subA: true,
          nested: { y: 2, x: 1 }
        }
      };

      const objB = {
        a: 'hello',
        m: {
          nested: { x: 1, y: 2 },
          subA: true,
          subZ: false
        },
        z: 100
      };

      expect(stableSerialize(objA)).toBe(stableSerialize(objB));
    });

    it('handles international Unicode, Turkish characters, and emojis deterministically', () => {
      const turkishObj1 = { şehir: 'İstanbul', çay: true, ılık: 42 };
      const turkishObj2 = { ılık: 42, şehir: 'İstanbul', çay: true };
      expect(stableSerialize(turkishObj1)).toBe(stableSerialize(turkishObj2));

      const emojiObj1 = { '🚀': 'rocket', '🔥': 'fire', '⭐': 'star' };
      const emojiObj2 = { '⭐': 'star', '🚀': 'rocket', '🔥': 'fire' };
      expect(stableSerialize(emojiObj1)).toBe(stableSerialize(emojiObj2));
    });

    it('correctly serializes nested arrays, empty collections, and mixed types', () => {
      expect(stableSerialize([])).toBe('[]');
      expect(stableSerialize({})).toBe('{}');
      expect(stableSerialize([1, 'two', { b: 2, a: 1 }])).toBe('[1,"two",{"a":1,"b":2}]');
      expect(stableSerialize({ list: [{}, { k: 'v' }] })).toBe('{"list":[{},{"k":"v"}]}');
    });

    it('distinguishes null and undefined values appropriately', () => {
      expect(stableSerialize(null)).toBe('null');
      expect(stableSerialize(undefined)).toBeUndefined();
      expect(stableSerialize({ a: null })).toBe('{"a":null}');
    });

    it('serializes numbers and floats consistently', () => {
      expect(stableSerialize(0)).toBe('0');
      expect(stableSerialize(-42)).toBe('-42');
      expect(stableSerialize(3.14)).toBe('3.14');
    });
  });

  describe('2. ToolCacheManager LRU Eviction & Recency', () => {
    let cache: ToolCacheManager;

    beforeEach(() => {
      cache = new ToolCacheManager();
    });

    it('evicts oldest entry when maxSize is 1', () => {
      const config = { ttlMs: 60_000, maxSize: 1 };
      const res1 = { content: [{ type: 'text' as const, text: 'one' }], data: 1 };
      const res2 = { content: [{ type: 'text' as const, text: 'two' }], data: 2 };

      cache.set('toolA', { id: 1 }, res1, config);
      expect(cache.get('toolA', { id: 1 }, config)).toEqual(res1);

      // Inserting second item must evict the first item immediately
      cache.set('toolA', { id: 2 }, res2, config);
      expect(cache.get('toolA', { id: 1 }, config)).toBeUndefined();
      expect(cache.get('toolA', { id: 2 }, config)).toEqual(res2);

      const stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.evictions).toBe(1);
    });

    it('updates LRU recency on get() preventing active items from eviction', () => {
      const config = { ttlMs: 60_000, maxSize: 2 };
      const resA = { content: [{ type: 'text' as const, text: 'A' }], data: 'A' };
      const resB = { content: [{ type: 'text' as const, text: 'B' }], data: 'B' };
      const resC = { content: [{ type: 'text' as const, text: 'C' }], data: 'C' };

      cache.set('tool', { k: 'A' }, resA, config);
      cache.set('tool', { k: 'B' }, resB, config);

      // Access A -> moves A to most recently used (MRU)
      expect(cache.get('tool', { k: 'A' }, config)).toEqual(resA);

      // Now insert C -> B is least recently used (LRU) and must be evicted instead of A
      cache.set('tool', { k: 'C' }, resC, config);

      expect(cache.get('tool', { k: 'A' }, config)).toEqual(resA);
      expect(cache.get('tool', { k: 'B' }, config)).toBeUndefined(); // B evicted
      expect(cache.get('tool', { k: 'C' }, config)).toEqual(resC);

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
      expect(stats.size).toBe(2);
    });

    it('updating an existing key refreshes its value without incrementing eviction count', () => {
      const config = { ttlMs: 60_000, maxSize: 2 };
      const res1 = { content: [{ type: 'text' as const, text: 'v1' }], data: 'v1' };
      const res2 = { content: [{ type: 'text' as const, text: 'v2' }], data: 'v2' };

      cache.set('tool', { id: 10 }, res1, config);
      cache.set('tool', { id: 10 }, res2, config);

      expect(cache.get('tool', { id: 10 }, config)).toEqual(res2);
      expect(cache.getStats().size).toBe(1);
      expect(cache.getStats().evictions).toBe(0);
    });
  });

  describe('3. TTL Expiration Boundaries', () => {
    it('expires immediately when ttlMs is negative or zero', () => {
      const cache = new ToolCacheManager();
      const res = { content: [{ type: 'text' as const, text: 'expired' }], data: 0 };

      // Set with negative TTL
      cache.set('tool', { q: 'quick' }, res, { ttlMs: -1000 });
      expect(cache.get('tool', { q: 'quick' })).toBeUndefined();

      // Stats should reflect miss
      expect(cache.getStats().misses).toBe(1);
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('4. Selective Cache Clearing', () => {
    it('clears cache entries selectively by toolName without affecting other tools', () => {
      const cache = new ToolCacheManager();
      const dummyRes = { content: [{ type: 'text' as const, text: 'ok' }], data: true };

      cache.set('tool_weather', { city: 'Istanbul' }, dummyRes);
      cache.set('tool_weather', { city: 'London' }, dummyRes);
      cache.set('tool_finance', { symbol: 'AAPL' }, dummyRes);

      expect(cache.getStats().size).toBe(3);

      // Clear only tool_weather
      const cleared = cache.clear('tool_weather');
      expect(cleared).toBe(2);
      expect(cache.getStats().size).toBe(1);

      // tool_finance is still intact
      expect(cache.get('tool_finance', { symbol: 'AAPL' })).toEqual(dummyRes);
      expect(cache.get('tool_weather', { city: 'Istanbul' })).toBeUndefined();

      // Global clear removes remaining entries
      const globalCleared = cache.clear();
      expect(globalCleared).toBe(1);
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('5. Custom Key Generator Handling', () => {
    it('uses custom keyGenerator when provided in config', () => {
      const cache = new ToolCacheManager();
      const dummyRes = { content: [{ type: 'text' as const, text: 'ok' }], data: 100 };

      const config = {
        keyGenerator: (args: any) => `custom:${args.city?.toLowerCase()}`
      };

      cache.set('weather', { city: 'AnKaRa', unusedProp: 999 }, dummyRes, config);

      // Different casing or extra properties should still match custom key
      const hit = cache.get('weather', { city: 'ankara', differentProp: 1 }, config);
      expect(hit).toEqual(dummyRes);
      expect(cache.getStats().hits).toBe(1);
    });
  });
});
