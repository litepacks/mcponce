import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  parseCliValue,
  parseParametricArgs,
  printToolsList,
  printToolHelp,
  executeCliToolCall
} from '../src/cli/tool-caller.js';
import { createMcpServer } from '../src/server/app.js';
import { handleCliArgs } from '../src/cli/index.js';
import { resolveConfig } from '../src/runtime/config.js';

describe('CLI Parametric Tool Caller', () => {
  describe('parseCliValue', () => {
    it('parses boolean, null, and number primitives', () => {
      expect(parseCliValue('true')).toBe(true);
      expect(parseCliValue('false')).toBe(false);
      expect(parseCliValue('null')).toBe(null);
      expect(parseCliValue('42')).toBe(42);
      expect(parseCliValue('-10.5')).toBe(-10.5);
      expect(parseCliValue('1e3')).toBe(1000);
      expect(parseCliValue('0')).toBe(0);
    });

    it('parses JSON objects and arrays', () => {
      expect(parseCliValue('{"name": "Alice", "score": 95}')).toEqual({
        name: 'Alice',
        score: 95
      });
      expect(parseCliValue('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(parseCliValue('["red", "green", "blue"]')).toEqual(['red', 'green', 'blue']);
    });

    it('keeps plain strings as strings', () => {
      expect(parseCliValue('hello world')).toBe('hello world');
      expect(parseCliValue('calculate')).toBe('calculate');
      expect(parseCliValue('https://example.com')).toBe('https://example.com');
      // Malformed JSON falls back to string
      expect(parseCliValue('{not-json}')).toBe('{not-json}');
    });
  });

  describe('parseParametricArgs', () => {
    it('parses named flags with space and equals separator', () => {
      const parsed = parseParametricArgs([
        '--operation', 'add',
        '--a', '10',
        '--b=25',
        '-c', 'true'
      ]);

      expect(parsed.params).toEqual({
        operation: 'add',
        a: 10,
        b: 25,
        c: true
      });
      expect(parsed.isJsonOutput).toBe(false);
      expect(parsed.isHelp).toBe(false);
    });

    it('parses boolean flags and negated flags', () => {
      const parsed = parseParametricArgs(['--verbose', '--no-cache', '--force']);
      expect(parsed.params).toEqual({
        verbose: true,
        cache: false,
        force: true
      });
    });

    it('parses positional JSON string payloads', () => {
      const parsed = parseParametricArgs([
        '{"operation": "multiply", "a": 6, "b": 7}'
      ]);

      expect(parsed.params).toEqual({
        operation: 'multiply',
        a: 6,
        b: 7
      });
    });

    it('allows flags to override positional JSON values', () => {
      const parsed = parseParametricArgs([
        '{"operation": "add", "a": 5, "b": 10}',
        '--b', '20',
        '--c', '100'
      ]);

      expect(parsed.params).toEqual({
        operation: 'add',
        a: 5,
        b: 20,
        c: 100
      });
    });

    it('extracts CLI control flags (--json, --timeout, --help)', () => {
      const parsed = parseParametricArgs([
        '--name', 'Alice',
        '--json',
        '--timeout', '8000',
        '-h'
      ]);

      expect(parsed.params).toEqual({ name: 'Alice' });
      expect(parsed.isJsonOutput).toBe(true);
      expect(parsed.timeoutMs).toBe(8000);
      expect(parsed.isHelp).toBe(true);
    });

    it('supports --timeout=1234 syntax', () => {
      const parsed = parseParametricArgs(['--timeout=4500']);
      expect(parsed.timeoutMs).toBe(4500);
    });
  });

  describe('executeCliToolCall & handleCliArgs Integration', () => {
    let logSpy: any;
    let errorSpy: any;
    let exitSpy: any;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('executes tool with named flags and logs result to stdout', async () => {
      const app = createMcpServer({ name: 'test-calc' });
      app.tool({
        name: 'calculate',
        description: 'Perform math calculations',
        inputSchema: {
          operation: 'string',
          a: 'number',
          b: 'number'
        },
        async handler({ operation, a, b }) {
          if (operation === 'add') return { result: a + b };
          if (operation === 'multiply') return { result: a * b };
          return { result: 0 };
        }
      });

      await executeCliToolCall(app, 'calculate', [
        '--operation', 'add',
        '-a', '15',
        '-b', '35'
      ]);

      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(output).toContain('"result": 50');
    });

    it('outputs raw JSON when --json flag is provided', async () => {
      const app = createMcpServer({ name: 'test-json-out' });
      app.tool({
        name: 'greet',
        inputSchema: { name: 'string' },
        async handler({ name }) {
          return { greeting: `Hello, ${name}!` };
        }
      });

      await executeCliToolCall(app, 'greet', ['--name', 'Bob', '--json']);

      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      const parsed = JSON.parse(output);
      expect(parsed).toEqual({ greeting: 'Hello, Bob!' });
    });

    it('prints tool help when --help is passed to a tool call', async () => {
      const app = createMcpServer({ name: 'test-help' });
      app.tool({
        name: 'test_tool',
        description: 'A test tool description',
        inputSchema: {
          reqStr: 'string',
          reqNum: 'number'
        },
        async handler() {
          return 'ok';
        }
      });

      await executeCliToolCall(app, 'test_tool', ['--help']);

      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(output).toContain('Tool: test_tool');
      expect(output).toContain('A test tool description');
      expect(output).toContain('--reqStr <string>');
      expect(output).toContain('--reqNum <number>');
      expect(output).toContain('Example:');
    });

    it('handles non-existent tool with error and exits with code 1', async () => {
      const app = createMcpServer({ name: 'test-missing' });
      app.tool({
        name: 'existing_tool',
        inputSchema: {},
        async handler() { return 'ok'; }
      });

      await executeCliToolCall(app, 'unknown_tool', []);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = errorSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Tool "unknown_tool" not found');
      expect(errorOutput).toContain('existing_tool');
    });

    it('handles tool execution errors gracefully and exits with code 1', async () => {
      const app = createMcpServer({ name: 'test-err' });
      app.tool({
        name: 'failing_tool',
        inputSchema: {},
        async handler() {
          throw new Error('Database connection failed');
        }
      });

      await executeCliToolCall(app, 'failing_tool', []);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = errorSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Database connection failed');
    });

    it('lists all registered tools via printToolsList', async () => {
      const app = createMcpServer({ name: 'test-tools-list' });
      app.tool({
        name: 'tool_one',
        description: 'First tool',
        inputSchema: { id: 'string' },
        async handler() { return '1'; }
      });
      app.tool({
        name: 'tool_two',
        description: 'Second tool',
        inputSchema: { count: 'number' },
        async handler() { return '2'; }
      });

      printToolsList(app.getTools());

      const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(output).toContain('Registered Tools (2)');
      expect(output).toContain('tool_one');
      expect(output).toContain('First tool');
      expect(output).toContain('tool_two');
      expect(output).toContain('Second tool');
    });

    it('integrates seamlessly with handleCliArgs for "call" and "tools"', async () => {
      const app = createMcpServer({ name: 'test-cli-args' });
      app.tool({
        name: 'echo',
        inputSchema: { message: 'string' },
        async handler({ message }) {
          return { echo: message };
        }
      });
      const config = resolveConfig('test-cli-args');

      // 1. handleCliArgs with "call"
      const resCall = await handleCliArgs(
        ['call', 'echo', '--message', 'hello-world', '--json'],
        config,
        app
      );
      expect(resCall.isCliCommand).toBe(true);
      const callOutput = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(callOutput).toContain('"echo": "hello-world"');

      // 2. handleCliArgs with "tools"
      logSpy.mockClear();
      const resTools = await handleCliArgs(['tools'], config, app);
      expect(resTools.isCliCommand).toBe(true);
      const toolsOutput = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(toolsOutput).toContain('echo');
    });

    it('tests executeCliToolCall help, progress, error json, and formatCliProgress', async () => {
      const { formatCliProgress } = await import('../src/cli/tool-caller.js');
      expect(formatCliProgress({ tool: 't', progress: 5, total: 10 })).toContain('(50%)');
      expect(formatCliProgress({ tool: 't', progress: 5 })).toContain('[Progress t]');

      const app = createMcpServer({ name: 'test-extra' });
      app.tool({
        name: 'progress_tool',
        inputSchema: { n: 'number' },
        async handler({ n }, ctx) {
          await ctx.reportProgress?.(5, 10, 'halfway');
          return n * 2;
        }
      });

      // 1. call without tool name shows help
      logSpy.mockClear();
      await executeCliToolCall(app, undefined, []);
      expect(logSpy.mock.calls.some((c: any) => c[0]?.includes('Usage: call'))).toBe(true);

      // 2. call with tool name and --help
      logSpy.mockClear();
      await executeCliToolCall(app, 'progress_tool', ['--help']);
      expect(logSpy.mock.calls.some((c: any) => c[0]?.includes('Tool: progress_tool'))).toBe(true);

      // 3. call with progress
      logSpy.mockClear();
      await executeCliToolCall(app, 'progress_tool', ['--n', '21']);
      expect(logSpy.mock.calls.some((c: any) => c[0] === '42')).toBe(true);

      // 4. tool without parameters help
      app.tool({
        name: 'no_params',
        inputSchema: {},
        async handler() { return 'ok'; }
      });
      logSpy.mockClear();
      printToolHelp(app.getTool('no_params'));
      expect(logSpy.mock.calls.some((c: any) => c[0]?.includes('Parameters: None'))).toBe(true);

      // 5. empty tools list
      logSpy.mockClear();
      printToolsList([]);
      expect(logSpy.mock.calls.some((c: any) => c[0]?.includes('No tools registered on this server'))).toBe(true);
    });

    it('covers all parseParametricArgs token, flag, and json parsing branches', () => {
      const parsed = parseParametricArgs([
        '--no-progress',
        '--token', 'tok1',
        '--api-key', 'key1',
        '--token=tok2',
        '--api-key=key2',
        '--no-debug',
        '{bad-json}'
      ]);

      expect(parsed.noProgress).toBe(true);
      expect(parsed.token).toBe('key2');
      expect(parsed.params.debug).toBe(false);
    });

    it('inspects Zod schemas and all type variations in printToolHelp', () => {
      const app = createMcpServer({ name: 'zod-app' });
      app.tool({
        name: 'full_zod_tool',
        description: 'Comprehensive schema tool',
        inputSchema: {
          optStr: z.string().optional().describe('Optional string'),
          defNum: z.number().default(() => 42),
          boolVal: z.boolean(),
          listVal: z.array(z.string()),
          objVal: z.object({ key: z.string() }),
          recVal: z.record(z.any()),
          anyVal: z.any()
        },
        async handler() { return 'ok'; }
      });

      logSpy.mockClear();
      printToolHelp(app.getTool('full_zod_tool'));
      const rawOutput = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      const output = rawOutput.replace(/\x1b\[[0-9;]*m/g, '');
      expect(output).toContain('--optStr <string> (optional)');
      expect(output).toContain('--defNum <number> (optional) [default: 42]');
      expect(output).toContain('--boolVal <boolean> (required)');
      expect(output).toContain('--listVal <array> (required)');
      expect(output).toContain('--objVal <object> (required)');
    });

    it('covers executeCliToolCall output formats and error handling branches', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const app = createMcpServer({ name: 'call-formats-app' });

      // 1. Tool returning error with --json
      app.tool({
        name: 'error_json_tool',
        async handler() {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Custom error occurred' }],
            text: 'Custom error occurred'
          };
        }
      });
      logSpy.mockClear();
      await executeCliToolCall(app, 'error_json_tool', ['--json']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errOut = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(errOut).toContain('Custom error occurred');

      // 2. Tool returning plain text string
      app.tool({
        name: 'text_tool',
        async handler() {
          return 'Hello from plain text';
        }
      });
      logSpy.mockClear();
      await executeCliToolCall(app, 'text_tool', []);
      expect(logSpy.mock.calls.some((c: any) => c[0] === 'Hello from plain text')).toBe(true);

      // 3. Tool returning primitive number/boolean in result.data
      app.tool({
        name: 'primitive_tool',
        async handler() {
          return 999;
        }
      });
      logSpy.mockClear();
      await executeCliToolCall(app, 'primitive_tool', []);
      expect(logSpy.mock.calls.some((c: any) => c[0] === '999')).toBe(true);

      // 4. Exception thrown with --json and progress
      app.tool({
        name: 'throw_tool',
        async handler(_args, ctx) {
          await ctx.reportProgress?.(1, 2, 'starting');
          throw new Error('Exploded unexpectedly');
        }
      });
      logSpy.mockClear();
      await executeCliToolCall(app, 'throw_tool', ['--json']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      const thrownOut = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
      expect(thrownOut).toContain('Exploded unexpectedly');

      exitSpy.mockRestore();
    });
  });
});
