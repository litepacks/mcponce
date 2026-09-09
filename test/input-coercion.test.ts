import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  createMcpServer,
  McpApp,
  coerceNumber,
  coerceBoolean,
  coerceObject,
  coerceArray,
  coerceString,
  getParameterInfo
} from '../src/index.js';
import {
  smartCoerceValue,
  buildCoercedZodSchema,
  coerceArguments
} from '../src/utils/coercion.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Smart Input Coercion & Schema Defaults', () => {
  let app: McpApp;
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = path.join(
      os.tmpdir(),
      `mcponce-test-coercion-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });

    app = createMcpServer({
      name: 'test-coercion-server',
      version: '1.0.0',
      dataDir: testDataDir,
      logging: false
    });
  });

  afterEach(async () => {
    try {
      await app.stop();
    } catch {}
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Unit: Coercion utilities', () => {
    it('coerces numbers properly and handles invalid inputs', () => {
      expect(coerceNumber('42')).toBe(42);
      expect(coerceNumber('3.14')).toBe(3.14);
      expect(coerceNumber('-10.5')).toBe(-10.5);
      expect(coerceNumber(99)).toBe(99);
      expect(coerceNumber(true)).toBe(1);
      expect(coerceNumber(false)).toBe(0);
      expect(coerceNumber('not_a_number')).toBe('not_a_number');
      expect(coerceNumber('')).toBe('');
    });

    it('coerces booleans properly avoiding Boolean("false") === true bug', () => {
      // Falsy strings & numbers
      expect(coerceBoolean('false')).toBe(false);
      expect(coerceBoolean('FALSE')).toBe(false);
      expect(coerceBoolean('  false  ')).toBe(false);
      expect(coerceBoolean('0')).toBe(false);
      expect(coerceBoolean('no')).toBe(false);
      expect(coerceBoolean('off')).toBe(false);
      expect(coerceBoolean(0)).toBe(false);
      expect(coerceBoolean(false)).toBe(false);

      // Truthy strings & numbers
      expect(coerceBoolean('true')).toBe(true);
      expect(coerceBoolean('TRUE')).toBe(true);
      expect(coerceBoolean('  true  ')).toBe(true);
      expect(coerceBoolean('1')).toBe(true);
      expect(coerceBoolean('yes')).toBe(true);
      expect(coerceBoolean('on')).toBe(true);
      expect(coerceBoolean(1)).toBe(true);
      expect(coerceBoolean(true)).toBe(true);

      // Pass-through for invalid values
      expect(coerceBoolean('maybe')).toBe('maybe');
    });

    it('coerces objects from stringified JSON', () => {
      expect(coerceObject('{"key": "value", "num": 10}')).toEqual({ key: 'value', num: 10 });
      expect(coerceObject({ direct: true })).toEqual({ direct: true });
      expect(coerceObject('invalid json')).toBe('invalid json');
    });

    it('coerces arrays from JSON arrays and scalar values', () => {
      expect(coerceArray('["a", "b", "c"]')).toEqual(['a', 'b', 'c']);
      expect(coerceArray(['x', 'y'])).toEqual(['x', 'y']);
      expect(coerceArray('single_tag')).toEqual(['single_tag']);
      expect(coerceArray(123)).toEqual([123]);
      expect(coerceArray(null)).toBeNull();
      expect(coerceArray(undefined)).toBeUndefined();
    });

    it('coerces strings from numbers and booleans', () => {
      expect(coerceString(123)).toBe('123');
      expect(coerceString(true)).toBe('true');
      expect(coerceString('already_string')).toBe('already_string');
      expect(coerceString({ foo: 'bar' })).toEqual({ foo: 'bar' });
    });
  });

  describe('Integration: Extended Property Config & Defaults', () => {
    it('applies schema defaults when fields are omitted or undefined', async () => {
      app.tool({
        name: 'pagination_tool',
        inputSchema: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 25 },
          activeOnly: { type: 'boolean', default: true }
        },
        handler: ({ page, limit, activeOnly }) => {
          return { page, limit, activeOnly };
        }
      });

      // 1. Omit all fields
      const res1 = await app.callTool('pagination_tool', {});
      expect(res1.data).toEqual({ page: 1, limit: 25, activeOnly: true });

      // 2. Explicit undefined fields
      const res2 = await app.callTool('pagination_tool', { page: undefined, limit: 50 });
      expect(res2.data).toEqual({ page: 1, limit: 50, activeOnly: true });

      // 3. Explicit values provided
      const res3 = await app.callTool('pagination_tool', { page: 3, limit: 10, activeOnly: false });
      expect(res3.data).toEqual({ page: 3, limit: 10, activeOnly: false });
    });

    it('supports optional fields without default values via required: false', async () => {
      app.tool({
        name: 'optional_tool',
        inputSchema: {
          requiredName: { type: 'string', required: true },
          optionalNote: { type: 'string', required: false }
        },
        handler: (input) => input
      });

      const res = await app.callTool('optional_tool', { requiredName: 'Alpha' });
      expect(res.data).toEqual({ requiredName: 'Alpha' });

      await expect(app.callTool('optional_tool', {})).rejects.toThrow('requiredName');
    });
  });

  describe('Integration: Tool-Level coerceInputs: true', () => {
    it('coerces stringified arguments when coerceInputs: true on tool', async () => {
      app.tool({
        name: 'typed_calculator',
        coerceInputs: true,
        inputSchema: {
          count: 'number',
          active: 'boolean',
          meta: 'object',
          tags: 'array'
        },
        handler: ({ count, active, meta, tags }) => {
          return {
            countType: typeof count,
            count,
            activeType: typeof active,
            active,
            meta,
            tags
          };
        }
      });

      const res = await app.callTool('typed_calculator', {
        count: '42.5',
        active: 'false',
        meta: '{"environment": "production"}',
        tags: '["frontend", "backend"]'
      });

      expect(res.data).toEqual({
        countType: 'number',
        count: 42.5,
        activeType: 'boolean',
        active: false,
        meta: { environment: 'production' },
        tags: ['frontend', 'backend']
      });
    });

    it('rejects stringified numbers when coerceInputs is false (default)', async () => {
      app.tool({
        name: 'strict_tool',
        inputSchema: {
          value: 'number'
        },
        handler: ({ value }) => value
      });

      await expect(
        app.callTool('strict_tool', { value: '123' })
      ).rejects.toThrow(/Validation failed.*value/);
    });

    it('supports per-property coerce: true override in extended schema', async () => {
      app.tool({
        name: 'mixed_coercion',
        inputSchema: {
          coercedNum: { type: 'number', coerce: true },
          strictNum: 'number'
        },
        handler: (input) => input
      });

      // coercedNum accepts "99", but strictNum still requires true number
      const res = await app.callTool('mixed_coercion', {
        coercedNum: '99',
        strictNum: 50
      });
      expect(res.data).toEqual({ coercedNum: 99, strictNum: 50 });

      await expect(
        app.callTool('mixed_coercion', { coercedNum: '99', strictNum: '50' })
      ).rejects.toThrow(/strictNum/);
    });
  });

  describe('Integration: Server-Level coerceInputs', () => {
    it('automatically enables coercion across all tools when configured at server level', async () => {
      const serverApp = createMcpServer({
        name: 'auto-coerce-server',
        dataDir: path.join(testDataDir, 'sub'),
        coerceInputs: true,
        logging: false
      });

      serverApp.tool({
        name: 'math_add',
        inputSchema: { a: 'number', b: 'number' },
        handler: ({ a, b }) => a + b
      });

      const res = await serverApp.callTool('math_add', { a: '15', b: '35' });
      expect(res.data).toBe(50);

      await serverApp.stop();
    });
  });

  describe('Integration: Per-Call Override via CallOptions', () => {
    it('allows caller to bypass coercion using { coerceInputs: false }', async () => {
      app.tool({
        name: 'coerced_by_default',
        coerceInputs: true,
        inputSchema: { val: 'number' },
        handler: ({ val }) => val
      });

      // Normal call coerces "100" to 100
      const ok = await app.callTool('coerced_by_default', { val: '100' });
      expect(ok.data).toBe(100);

      // Explicit bypass fails validation
      await expect(
        app.callTool('coerced_by_default', { val: '100' }, { coerceInputs: false })
      ).rejects.toThrow(/val/);
    });

    it('allows caller to enable coercion using { coerceInputs: true } on a strict tool', async () => {
      app.tool({
        name: 'strict_by_default',
        inputSchema: { val: 'number' },
        handler: ({ val }) => val
      });

      // Normal call fails
      await expect(
        app.callTool('strict_by_default', { val: '100' })
      ).rejects.toThrow(/val/);

      // Explicit enable coerces and succeeds
      const res = await app.callTool('strict_by_default', { val: '100' }, { coerceInputs: true });
      expect(res.data).toBe(100);
    });
  });

  describe('Integration: Remote MCP Client calls over HTTP', () => {
    it('coerces remote MCP tool arguments over HTTP /mcp', async () => {
      app.tool({
        name: 'remote_coerced',
        coerceInputs: true,
        inputSchema: {
          id: { type: 'number', default: 1 },
          dryRun: { type: 'boolean', default: false }
        },
        handler: ({ id, dryRun }) => {
          return { id, dryRun, idType: typeof id, dryRunType: typeof dryRun };
        }
      });

      const startRes = await app.start({ role: 'owner' });
      const baseUrl = `http://${startRes.host}:${startRes.port}`;

      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'remote_coerced',
            arguments: {
              id: '99',
              dryRun: 'true'
            }
          }
        })
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

      expect(json.result).toBeDefined();
      expect(json.result.isError).toBeFalsy();
      expect(json.result.text).toContain('"id":99');
      expect(json.result.text).toContain('"dryRun":true');
    });
  });

  describe('CLI Reflection: getParameterInfo', () => {
    it('extracts type, defaults, and descriptions for CLI help display', () => {
      app.tool({
        name: 'documented_tool',
        inputSchema: {
          page: { type: 'number', default: 1, description: 'Page number' },
          query: { type: 'string', required: true, description: 'Filter query' }
        },
        handler: (args) => args
      });

      const tool = app.toolRegistry.get('documented_tool')!;
      const pageInfo = getParameterInfo('page', tool);
      expect(pageInfo.type).toBe('number');
      expect(pageInfo.required).toBe(false);
      expect(pageInfo.default).toBe(1);
      expect(pageInfo.description).toBe('Page number');

      const queryInfo = getParameterInfo('query', tool);
      expect(queryInfo.type).toBe('string');
      expect(queryInfo.required).toBe(true);
      expect(queryInfo.description).toBe('Filter query');
    });

    it('covers buildCoercedZodSchema for all types and fallbacks', () => {
      expect(buildCoercedZodSchema('number').parse('42')).toBe(42);
      expect(buildCoercedZodSchema('boolean').parse('true')).toBe(true);
      expect(buildCoercedZodSchema('string').parse(123)).toBe('123');
      expect(buildCoercedZodSchema('object').parse('{"a":1}')).toEqual({ a: 1 });
      expect(buildCoercedZodSchema('array').parse('["item"]')).toEqual(['item']);
      expect(buildCoercedZodSchema('unknown' as any).parse('raw')).toBe('raw');
    });

    it('covers smartCoerceValue fallback and coerceArguments with diverse schemas', () => {
      // smartCoerceValue fallback
      expect(smartCoerceValue('test', 'custom_type' as any)).toBe('test');

      // coerceArguments null / undefined checks
      expect(coerceArguments(null as any, {})).toEqual({});
      expect(coerceArguments({ a: 1 }, null as any)).toEqual({ a: 1 });

      // coerceArguments with string and object type definitions
      const args = {
        n: '10',
        b: 'yes',
        s: 99,
        arr: 'foo',
        obj: '{"k": 1}',
        unregistered: 'skip'
      };

      const stringSchema = {
        n: 'number',
        b: 'boolean',
        s: 'string',
        arr: 'array',
        obj: 'object'
      };
      const resultString = coerceArguments(args, stringSchema);
      expect(resultString.n).toBe(10);
      expect(resultString.b).toBe(true);
      expect(resultString.s).toBe('99');
      expect(resultString.arr).toEqual(['foo']);
      expect(resultString.obj).toEqual({ k: 1 });
      expect(resultString.unregistered).toBe('skip');

      // coerceArguments with object type definitions
      const objectSchema = {
        n: { type: 'number' },
        b: { type: 'boolean' }
      };
      const resultObj = coerceArguments({ n: '20', b: 'false' }, objectSchema);
      expect(resultObj.n).toBe(20);
      expect(resultObj.b).toBe(false);

      // coerceArguments with Zod types
      const zodSchema = {
        zNum: z.number(),
        zBool: z.boolean(),
        zStr: z.string(),
        zArr: z.array(z.string()),
        zObj: z.object({ x: z.number() }),
        zRec: z.record(z.any())
      };
      const resultZod = coerceArguments({
        zNum: '100',
        zBool: '1',
        zStr: 555,
        zArr: 'item',
        zObj: '{"x": 42}',
        zRec: '{"y": 24}'
      }, zodSchema);
      expect(resultZod.zNum).toBe(100);
      expect(resultZod.zBool).toBe(true);
      expect(resultZod.zStr).toBe('555');
      expect(resultZod.zArr).toEqual(['item']);
      expect(resultZod.zObj).toEqual({ x: 42 });
      expect(resultZod.zRec).toEqual({ y: 24 });
    });
  });
});
