import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../src/index.js';

describe('Timeout, Cancellation, and Error Handling', () => {
  it('1. times out when tool execution exceeds tool-specific timeoutMs', async () => {
    const app = createMcpServer({
      name: 'test-timeout-tool-specific',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'slow_tool',
      description: 'A tool that takes too long',
      timeoutMs: 100, // 100ms timeout
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true };
      }
    });

    await expect(app.callTool('slow_tool')).rejects.toThrow(
      'Tool "slow_tool" execution timed out after 100ms'
    );
  });

  it('2. supports throwOnError: false to return structured { isError: true } instead of throwing', async () => {
    const app = createMcpServer({
      name: 'test-throw-on-error-false',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'failing_tool',
      timeoutMs: 80,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ok: true };
      }
    });

    const result = await app.callTool('failing_tool', {}, { throwOnError: false });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Tool "failing_tool" execution timed out after 80ms');
    expect(result.content[0].type).toBe('text');
  });

  it('3. server-level toolTimeoutMs applies when tool does not define its own timeout', async () => {
    const app = createMcpServer({
      name: 'test-server-level-timeout',
      toolTimeoutMs: 150, // Server-wide default
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'default_timeout_tool',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return 'done';
      }
    });

    await expect(app.callTool('default_timeout_tool')).rejects.toThrow(
      'Tool "default_timeout_tool" execution timed out after 150ms'
    );
  });

  it('4. tool-level timeoutMs: 0 disables timeout', async () => {
    const app = createMcpServer({
      name: 'test-timeout-disabled',
      toolTimeoutMs: 50, // Strict server default
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'unlimited_tool',
      timeoutMs: 0, // Explicitly disable timeout
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'completed successfully';
      }
    });

    const res = await app.callTool('unlimited_tool');
    expect(res.data).toBe('completed successfully');
  });

  it('5. allows cancellation via AbortSignal passed to callTool', async () => {
    const app = createMcpServer('test-cancellation-signal');

    let wasAborted = false;

    app.tool({
      name: 'cancellable_tool',
      handler: async (args, { signal }) => {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            wasAborted = true;
            return reject(new Error('Aborted immediately'));
          }
          signal?.addEventListener('abort', () => {
            wasAborted = true;
            reject(new Error('Operation cancelled by signal'));
          });
          setTimeout(() => resolve('finished'), 1000);
        });
      }
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('User clicked cancel')), 50);

    await expect(
      app.callTool('cancellable_tool', {}, { signal: controller.signal })
    ).rejects.toThrow('User clicked cancel');

    expect(wasAborted).toBe(true);
  });

  it('6. cancels long-running tool even if handler ignores signal (via internal race)', async () => {
    const app = createMcpServer('test-cancellation-uncooperative');

    app.tool({
      name: 'stubborn_tool',
      handler: async () => {
        // Does not listen to signal, hangs for 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return 'eventually finished';
      }
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const start = Date.now();
    await expect(
      app.callTool('stubborn_tool', {}, { signal: controller.signal })
    ).rejects.toThrow(/aborted|cancelled/i);

    const duration = Date.now() - start;
    // Should have aborted around 60ms, not waited 2000ms
    expect(duration).toBeLessThan(500);
  });

  it('7. propagates cancellation through nested inter-tool calls', async () => {
    const app = createMcpServer('test-nested-cancellation');

    app.tool({
      name: 'inner_slow',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 'inner result';
      }
    });

    app.tool({
      name: 'outer_caller',
      handler: async (args, { callTool }) => {
        return await callTool('inner_slow');
      }
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Cancelled from top level')), 80);

    await expect(
      app.callTool('outer_caller', {}, { signal: controller.signal })
    ).rejects.toThrow('Cancelled from top level');
  });

  it('8. over MCP protocol (HTTP), tool errors & timeouts return structured isError without crashing server', async () => {
    const app = createMcpServer({
      name: 'test-mcp-http-timeout',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'crash_tool',
      inputSchema: {},
      handler: () => {
        throw new Error('Critical computation failed');
      }
    });

    app.tool({
      name: 'timeout_mcp_tool',
      timeoutMs: 100,
      inputSchema: {},
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'done';
      }
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // 1. Initialize MCP session
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

      // 2. Call crash_tool
      const crashRes = await fetch(`${baseUrl}/mcp`, {
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
            name: 'crash_tool',
            arguments: {}
          }
        })
      });
      expect(crashRes.status).toBe(200);
      const crashText = await crashRes.text();
      const crashJsonLine = crashText.split('\n').find((l) => l.startsWith('data: '))?.replace(/^data: /, '') || crashText;
      const crashData = JSON.parse(crashJsonLine);

      // Must be MCP spec compliant isError: true
      expect(crashData.result.isError).toBe(true);
      expect(crashData.result.content[0].text).toContain('Error in tool "crash_tool": Critical computation failed');

      // 3. Call timeout_mcp_tool
      const timeoutRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'timeout_mcp_tool',
            arguments: {}
          }
        })
      });
      expect(timeoutRes.status).toBe(200);
      const timeoutText = await timeoutRes.text();
      const timeoutJsonLine = timeoutText.split('\n').find((l) => l.startsWith('data: '))?.replace(/^data: /, '') || timeoutText;
      const timeoutData = JSON.parse(timeoutJsonLine);

      expect(timeoutData.result.isError).toBe(true);
      expect(timeoutData.result.content[0].text).toContain('Tool "timeout_mcp_tool" execution timed out after 100ms');

      // 4. Verify server is still completely alive and healthy
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('9. handles MCP client cancellation notification (notifications/cancelled)', async () => {
    const app = createMcpServer({
      name: 'test-mcp-client-cancellation',
      port: 0,
      registerInCentral: false
    });

    let toolSignalAborted = false;

    let onToolStarted: () => void;
    const toolStartedPromise = new Promise<void>((r) => { onToolStarted = r; });
    let onToolAborted: () => void;
    const toolAbortedPromise = new Promise<void>((r) => { onToolAborted = r; });

    app.tool({
      name: 'long_cancellable_task',
      inputSchema: {},
      handler: async (args, { signal }) => {
        onToolStarted?.();
        return new Promise((resolve) => {
          let timer: NodeJS.Timeout;
          if (signal?.aborted) {
            toolSignalAborted = true;
            onToolAborted?.();
            return resolve('aborted');
          }
          signal?.addEventListener('abort', () => {
            toolSignalAborted = true;
            clearTimeout(timer);
            onToolAborted?.();
            resolve('aborted');
          });
          timer = setTimeout(() => resolve('finished successfully'), 2000);
        });
      }
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // 1. Initialize MCP session
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

      // 2. Start calling long_cancellable_task with id: 99 (don't block, as spec drops cancelled response)
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'long_cancellable_task',
            arguments: {}
          }
        })
      }).catch(() => {});

      // 3. Wait until handler has actually started, then send notifications/cancelled for requestId: 99
      await toolStartedPromise;
      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: {
            requestId: 99,
            reason: 'User clicked cancel button'
          }
        })
      });

      // 4. Wait for cancellation to propagate into the tool's handler
      await Promise.race([
        toolAbortedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for abort signal')), 2000))
      ]);
      expect(toolSignalAborted).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

