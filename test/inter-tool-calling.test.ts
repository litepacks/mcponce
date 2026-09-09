import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../src/index.js';

describe('Inter-Tool Invocations (Calling tools within one another)', () => {
  it('1. allows a tool to invoke another tool using { callTool } from context', async () => {
    const app = createMcpServer('test-inter-tool-context');

    app.tool({
      name: 'add',
      inputSchema: { a: 'number', b: 'number' },
      handler: ({ a, b }) => {
        return { sum: a + b };
      }
    });

    app.tool({
      name: 'add_and_double',
      inputSchema: { a: 'number', b: 'number' },
      handler: async ({ a, b }, { callTool }) => {
        const addResult = await callTool('add', { a, b });
        return {
          originalSum: addResult.data.sum,
          doubled: addResult.data.sum * 2
        };
      }
    });

    const result = await app.callTool('add_and_double', { a: 10, b: 15 });
    expect(result.data.originalSum).toBe(25);
    expect(result.data.doubled).toBe(50);
    expect(result.content[0].type).toBe('text');
  });

  it('2. allows a tool to invoke another tool using 3rd extra argument { callTool }', async () => {
    const app = createMcpServer('test-inter-tool-extra');

    app.tool({
      name: 'uppercase',
      inputSchema: { text: 'string' },
      handler: ({ text }) => text.toUpperCase()
    });

    app.tool({
      name: 'greet_shouting',
      inputSchema: { name: 'string' },
      handler: async ({ name }, ctx, { callTool }) => {
        const res = await callTool('uppercase', { text: `Hello, ${name}!` });
        return res.text;
      }
    });

    const result = await app.callTool('greet_shouting', { name: 'Alice' });
    expect(result.text).toBe('HELLO, ALICE!');
    expect(result.data).toBe('HELLO, ALICE!');
  });

  it('3. allows calling tools directly via app.callTool(name, args)', async () => {
    const app = createMcpServer('test-inter-tool-app');

    app.tool({
      name: 'multiply',
      inputSchema: { x: 'number', y: 'number' },
      handler: ({ x, y }) => x * y
    });

    const result = await app.callTool('multiply', { x: 6, y: 7 });
    expect(result.data).toBe(42);
    expect(result.text).toBe('42');
  });

  it('4. detects and prevents circular tool invocations (A -> B -> A)', async () => {
    const app = createMcpServer('test-circular');

    app.tool({
      name: 'tool_a',
      inputSchema: {},
      handler: async (args, { callTool }) => {
        return await callTool('tool_b');
      }
    });

    app.tool({
      name: 'tool_b',
      inputSchema: {},
      handler: async (args, { callTool }) => {
        return await callTool('tool_a');
      }
    });

    await expect(app.callTool('tool_a')).rejects.toThrow(
      'Circular tool invocation detected: tool_a -> tool_b -> tool_a'
    );
  });

  it('5. validates arguments with Zod schema when calling tools', async () => {
    const app = createMcpServer('test-validation');

    app.tool({
      name: 'require_number',
      inputSchema: { n: 'number' },
      handler: ({ n }) => n * 2
    });

    // Valid call
    const ok = await app.callTool('require_number', { n: 5 });
    expect(ok.data).toBe(10);

    // Invalid call (wrong type)
    await expect(
      app.callTool('require_number', { n: 'not-a-number' as any })
    ).rejects.toThrow('Validation failed for tool "require_number"');
  });

  it('6. supports chained tool calls (A -> B -> C)', async () => {
    const app = createMcpServer('test-chain');

    app.tool({
      name: 'step1',
      inputSchema: { val: 'number' },
      handler: ({ val }) => val + 10
    });

    app.tool({
      name: 'step2',
      inputSchema: { val: 'number' },
      handler: async ({ val }, { callTool }) => {
        const res1 = await callTool('step1', { val });
        return res1.data * 2;
      }
    });

    app.tool({
      name: 'step3',
      inputSchema: { val: 'number' },
      handler: async ({ val }, { callTool }) => {
        const res2 = await callTool('step2', { val });
        return `Final: ${res2.data}`;
      }
    });

    const result = await app.callTool('step3', { val: 5 });
    // step1: 5 + 10 = 15
    // step2: 15 * 2 = 30
    // step3: "Final: 30"
    expect(result.data).toBe('Final: 30');
    expect(result.text).toBe('Final: 30');
  });

  it('7. allows inter-tool calling when invoked remotely by an MCP client over HTTP', async () => {
    const app = createMcpServer({
      name: 'test-http-inter-tool',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'helper_add',
      inputSchema: { a: 'number', b: 'number' },
      handler: ({ a, b }) => {
        return { sum: a + b };
      }
    });

    app.tool({
      name: 'main_calculator',
      inputSchema: { x: 'number', y: 'number' },
      handler: async ({ x, y }, { callTool }) => {
        const added = await callTool('helper_add', { a: x, b: y });
        return {
          total: added.data.sum * 10
        };
      }
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // 1. Initialize session
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
          }
        })
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get('mcp-session-id') || undefined;

      // 2. Call main_calculator over HTTP
      const callRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'main_calculator',
            arguments: { x: 3, y: 4 }
          }
        })
      });

      expect(callRes.status).toBe(200);
      const rawText = await callRes.text();
      // Parse SSE / JSON line
      const jsonLine = rawText.split('\n').find((l) => l.startsWith('data: '))?.replace(/^data: /, '') || rawText;
      const data = JSON.parse(jsonLine);

      expect(data.result.content[0].type).toBe('text');
      const parsedContent = JSON.parse(data.result.content[0].text);
      // (3 + 4) * 10 = 70
      expect(parsedContent.total).toBe(70);
    } finally {
      await app.stop();
    }
  });
});
