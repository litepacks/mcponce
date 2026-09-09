import { describe, it, expect, vi, beforeEach } from 'vitest';

class MockStdio {
  start = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  send = vi.fn().mockResolvedValue(undefined);
  onmessage?: (msg: any) => Promise<void>;
  onclose?: () => void;
  onerror?: (err: any) => void;
}

class MockHttp {
  start = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  send = vi.fn().mockResolvedValue(undefined);
  onmessage?: (msg: any) => Promise<void>;
  onclose?: () => void;
  onerror?: (err: any) => void;
}

let activeStdio: MockStdio;
let activeHttp: MockHttp;

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      activeStdio = new MockStdio();
      return activeStdio;
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor() {
      activeHttp = new MockHttp();
      return activeHttp;
    }
  }
}));

describe('startStdioProxy', () => {
  let startStdioProxy: any;
  let mockLogger: any;

  beforeEach(async () => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const mod = await import('../src/transport/proxy.js');
    startStdioProxy = mod.startStdioProxy;
  });

  it('starts stdio and http transports and returns proxy handle', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    expect(activeHttp.start).toHaveBeenCalled();
    expect(activeStdio.start).toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith('Stdio proxy successfully started', {
      mcpUrl: 'http://127.0.0.1:8080/mcp'
    });
    expect(handle).toHaveProperty('done');
    expect(handle).toHaveProperty('close');
    await handle.close();
  });

  it('forwards message from stdio to http transport', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };

    await activeStdio.onmessage!(msg);
    expect(activeHttp.send).toHaveBeenCalledWith(msg);
    await handle.close();
  });

  it('handles stdio to http forward error and sends JSON-RPC error back if msg has id', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeHttp.send.mockRejectedValueOnce(new Error('Network drop'));

    const msgWithId = { jsonrpc: '2.0', id: 42, method: 'tools/call' };
    await activeStdio.onmessage!(msgWithId);

    expect(mockLogger.error).toHaveBeenCalledWith('Error forwarding message from stdio to http', {
      error: 'Network drop'
    });
    expect(activeStdio.send).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 42,
      error: {
        code: -32603,
        message: 'Bridge failed to forward request: Network drop'
      }
    });
    await handle.close();
  });

  it('handles stdio to http forward error without id', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeHttp.send.mockRejectedValueOnce(new Error('Notification failed'));

    const notificationMsg = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await activeStdio.onmessage!(notificationMsg);

    expect(mockLogger.error).toHaveBeenCalledWith('Error forwarding message from stdio to http', {
      error: 'Notification failed'
    });
    expect(activeStdio.send).not.toHaveBeenCalled();
    await handle.close();
  });

  it('forwards message from http to stdio transport', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    const msg = { jsonrpc: '2.0', id: 1, result: { value: 'ok' } };

    await activeHttp.onmessage!(msg);
    expect(activeStdio.send).toHaveBeenCalledWith(msg);
    await handle.close();
  });

  it('handles http to stdio forward error gracefully', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeStdio.send.mockRejectedValueOnce(new Error('Stdout broken'));

    const msg = { jsonrpc: '2.0', id: 1, result: { value: 'ok' } };
    await activeHttp.onmessage!(msg);

    expect(mockLogger.error).toHaveBeenCalledWith('Error forwarding message from http to stdio', {
      error: 'Stdout broken'
    });
    await handle.close();
  });

  it('logs transport errors from stdio and http', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeStdio.onerror!(new Error('Stdio error'));
    expect(mockLogger.error).toHaveBeenCalledWith('Stdio transport error', { error: 'Stdio error' });

    activeHttp.onerror!(new Error('HTTP error'));
    expect(mockLogger.error).toHaveBeenCalledWith('HTTP client transport error', { error: 'HTTP error' });
    await handle.close();
  });

  it('cleans up when stdioTransport closes', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeStdio.onclose!();
    await handle.done;
    expect(activeHttp.close).toHaveBeenCalled();
  });

  it('cleans up when httpTransport closes', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    activeHttp.onclose!();
    await handle.done;
    expect(activeStdio.close).toHaveBeenCalled();
  });

  it('cleans up on process.stdin end/close and error events', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    process.stdin.emit('end');
    await handle.done;
  });

  it('cleans up on process.stdin error event', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    process.stdin.emit('error', new Error('stdin broken'));
    expect(mockLogger.debug).toHaveBeenCalledWith('Stdin stream error', { error: 'stdin broken' });
    await handle.done;
  });

  it('cleans up on stdout EPIPE error', async () => {
    const handle = await startStdioProxy('http://127.0.0.1:8080/mcp', mockLogger);
    const err: any = new Error('Broken pipe');
    err.code = 'EPIPE';
    process.stdout.emit('error', err);
    expect(mockLogger.debug).toHaveBeenCalledWith('Stdout stream closed with EPIPE (client disconnected)');
    await handle.done;
  });
});
