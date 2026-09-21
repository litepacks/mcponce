import { describe, it, expect } from 'vitest';
import {
  coerceNumber,
  coerceBoolean,
  coerceObject,
  coerceArray,
  coerceString,
  smartCoerceValue,
  coerceArguments
} from '../src/utils/coercion.js';

describe('Edge Cases: Input Coercion & Primitives', () => {
  describe('1. Number Coercion Boundary Values', () => {
    it('correctly handles zero variants (0, -0)', () => {
      expect(coerceNumber(0)).toBe(0);
      expect(coerceNumber('0')).toBe(0);
      expect(coerceNumber('-0')).toBe(-0);
      expect(Object.is(coerceNumber('-0'), -0)).toBe(true);
    });

    it('handles negative integers and floating point values', () => {
      expect(coerceNumber('-42')).toBe(-42);
      expect(coerceNumber('-3.14159')).toBeCloseTo(-3.14159);
      expect(coerceNumber('0.0000001')).toBeCloseTo(1e-7);
    });

    it('handles scientific notation strings', () => {
      expect(coerceNumber('1e5')).toBe(100000);
      expect(coerceNumber('2.5e-3')).toBe(0.0025);
      expect(coerceNumber('-1.5e2')).toBe(-150);
    });

    it('handles hexadecimal, octal and binary formatted number strings', () => {
      expect(coerceNumber('0x1f')).toBe(31);
      expect(coerceNumber('0b101')).toBe(5);
      expect(coerceNumber('0o77')).toBe(63);
    });

    it('handles large safe integers and limits', () => {
      expect(coerceNumber(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
      expect(coerceNumber(String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
      expect(coerceNumber('Infinity')).toBe(Infinity);
      expect(coerceNumber('-Infinity')).toBe(-Infinity);
    });

    it('does not coerce empty, whitespace-only, or non-numeric strings', () => {
      expect(coerceNumber('')).toBe('');
      expect(coerceNumber('   ')).toBe('   ');
      expect(coerceNumber('\t\r\n')).toBe('\t\r\n');
      expect(coerceNumber('abc')).toBe('abc');
      expect(coerceNumber('123abc')).toBe('123abc');
      expect(coerceNumber('NaN')).toBe('NaN');
    });

    it('handles null, undefined and symbol values gracefully without throwing', () => {
      expect(coerceNumber(null)).toBeNull();
      expect(coerceNumber(undefined)).toBeUndefined();
      const sym = Symbol('test');
      expect(coerceNumber(sym)).toBe(sym);
    });

    it('coerces booleans into numeric 1 and 0', () => {
      expect(coerceNumber(true)).toBe(1);
      expect(coerceNumber(false)).toBe(0);
    });
  });

  describe('2. Boolean Coercion Boundary Values', () => {
    it('preserves native boolean primitives', () => {
      expect(coerceBoolean(true)).toBe(true);
      expect(coerceBoolean(false)).toBe(false);
    });

    it('coerces truthy string representations regardless of case or whitespace', () => {
      expect(coerceBoolean('true')).toBe(true);
      expect(coerceBoolean('True')).toBe(true);
      expect(coerceBoolean('TRUE')).toBe(true);
      expect(coerceBoolean('  true  ')).toBe(true);
      expect(coerceBoolean('1')).toBe(true);
      expect(coerceBoolean('yes')).toBe(true);
      expect(coerceBoolean('YES')).toBe(true);
      expect(coerceBoolean('on')).toBe(true);
      expect(coerceBoolean('ON')).toBe(true);
    });

    it('coerces falsy string representations regardless of case or whitespace', () => {
      expect(coerceBoolean('false')).toBe(false);
      expect(coerceBoolean('False')).toBe(false);
      expect(coerceBoolean('FALSE')).toBe(false);
      expect(coerceBoolean('  false  ')).toBe(false);
      expect(coerceBoolean('0')).toBe(false);
      expect(coerceBoolean('no')).toBe(false);
      expect(coerceBoolean('NO')).toBe(false);
      expect(coerceBoolean('off')).toBe(false);
      expect(coerceBoolean('OFF')).toBe(false);
    });

    it('coerces numbers 1 and 0 to boolean', () => {
      expect(coerceBoolean(1)).toBe(true);
      expect(coerceBoolean(0)).toBe(false);
      // Other numbers remain unmodified
      expect(coerceBoolean(42)).toBe(42);
      expect(coerceBoolean(-1)).toBe(-1);
    });

    it('does not coerce arbitrary or ambiguous strings', () => {
      expect(coerceBoolean('maybe')).toBe('maybe');
      expect(coerceBoolean('null')).toBe('null');
      expect(coerceBoolean('undefined')).toBe('undefined');
      expect(coerceBoolean('')).toBe('');
      expect(coerceBoolean('   ')).toBe('   ');
    });

    it('leaves null, undefined and objects untouched', () => {
      expect(coerceBoolean(null)).toBeNull();
      expect(coerceBoolean(undefined)).toBeUndefined();
      expect(coerceBoolean({ ok: true })).toEqual({ ok: true });
    });
  });

  describe('3. Object & Array Coercion Edge Cases', () => {
    it('coerces valid stringified JSON objects', () => {
      expect(coerceObject('{"key": "val", "num": 123}')).toEqual({ key: 'val', num: 123 });
      expect(coerceObject('{}')).toEqual({});
    });

    it('returns raw string when JSON parsing fails or when input is an array', () => {
      expect(coerceObject('{invalid json')).toBe('{invalid json');
      expect(coerceObject('[1, 2, 3]')).toBe('[1, 2, 3]'); // Array is not an object record
      expect(coerceObject('plain text')).toBe('plain text');
    });

    it('coerces valid stringified JSON arrays', () => {
      expect(coerceArray('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(coerceArray('["hello", "world"]')).toEqual(['hello', 'world']);
      expect(coerceArray('[]')).toEqual([]);
    });

    it('wraps scalar non-array values into single-element array if not a JSON array', () => {
      expect(coerceArray('single_item')).toEqual(['single_item']);
      expect(coerceArray(42)).toEqual([42]);
      expect(coerceArray(true)).toEqual([true]);
    });

    it('handles null and undefined in array coercion', () => {
      expect(coerceArray(null)).toBeNull();
      expect(coerceArray(undefined)).toBeUndefined();
    });

    it('coerces scalars to string via coerceString', () => {
      expect(coerceString(123)).toBe('123');
      expect(coerceString(-45.67)).toBe('-45.67');
      expect(coerceString(true)).toBe('true');
      expect(coerceString(false)).toBe('false');
      expect(coerceString('already_string')).toBe('already_string');
      expect(coerceString(null)).toBeNull();
      expect(coerceString(undefined)).toBeUndefined();
    });
  });

  describe('4. smartCoerceValue & coerceArguments Schema Integration', () => {
    it('coerces multiple argument fields according to schema types', () => {
      const args = {
        age: '28',
        active: 'true',
        tags: '["alpha", "beta"]',
        meta: '{"role": "admin"}',
        note: 100
      };

      const schema = {
        age: 'number',
        active: 'boolean',
        tags: 'array',
        meta: 'object',
        note: 'string'
      };

      const result = coerceArguments(args, schema);

      expect(result).toEqual({
        age: 28,
        active: true,
        tags: ['alpha', 'beta'],
        meta: { role: 'admin' },
        note: '100'
      });
    });

    it('ignores arguments not defined in the schema', () => {
      const args = {
        known: '42',
        extraField: 'true',
        anotherExtra: '123'
      };

      const schema = {
        known: 'number'
      };

      const result = coerceArguments(args, schema);
      expect(result.known).toBe(42);
      expect(result.extraField).toBe('true');
      expect(result.anotherExtra).toBe('123');
    });

    it('supports property config objects with type property', () => {
      const args = { count: '99', debug: '1' };
      const schema = {
        count: { type: 'number', default: 10 },
        debug: { type: 'boolean', default: false }
      };

      const result = coerceArguments(args, schema);
      expect(result.count).toBe(99);
      expect(result.debug).toBe(true);
    });

    it('gracefully handles missing, empty, or non-object args', () => {
      expect(coerceArguments(null as any, {})).toEqual({});
      expect(coerceArguments(undefined as any, {})).toEqual({});
      expect(coerceArguments({}, undefined)).toEqual({});
      expect(coerceArguments({ a: 1 }, undefined)).toEqual({ a: 1 });
    });

    it('prevents prototype pollution vectors in arguments without crashing', () => {
      const args = JSON.parse('{"__proto__": {"polluted": true}, "count": "15"}');
      const schema = { count: 'number' };

      const result = coerceArguments(args, schema);
      expect(result.count).toBe(15);
      expect(({} as any).polluted).toBeUndefined();
    });
  });
});
