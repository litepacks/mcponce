import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, type McpApp } from '../src/index.js';
import { checkHealth } from '../src/runtime/health.js';
import { StateManager } from '../src/runtime/state.js';
import { LockManager } from '../src/runtime/lock.js';
import { _setUnitupModule, _resetUnitupModule } from '../src/runtime/unitup.js';
import { createProcessServiceManager, writeBackgroundEntrypoint } from './helpers/background-process.js';

// Replace the OS service manager at its API boundary. Workers, stdio bridges,
// HTTP/MCP, locks and runtime state are real; no native services are installed.
describe('Background lifecycle with real worker processes', () => {
  let testDir: string;
  let manager: ReturnType<typeof createProcessServiceManager>;
  let apps: McpApp[];
  let clients: Client[];

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp background test '));
    manager = createProcessServiceManager();
    _setUnitupModule(manager.adapter);
    apps = [];
    clients = [];
    for (const key of ['MCPONCE_BACKGROUND_SERVER', 'MCPONCE_API_KEY', 'MCP_API_KEY', 'MCP_TOKEN']) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(async () => {
    _setUnitupModule(manager.adapter);
    try {
      await Promise.all(clients.map((client) => client.close()));
      await Promise.all(apps.map((app) => app.stop()));
    } finally {
      await manager.dispose();
      _resetUnitupModule();
      vi.unstubAllEnvs();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeApp(name: string, background = true) {
    const dataDir = path.join(testDir, name);
    const entrypoint = writeBackgroundEntrypoint(name, dataDir);
    const app = createMcpServer({
      name, dataDir, entrypoint, background,
      host: '127.0.0.1', port: 0, registerInCentral: false,
      logging: { directory: path.join(dataDir, 'logs') }
    });
    apps.push(app);
    return app;
  }

  function makeClient() {
    const client = new Client({ name: 'background-lifecycle-test', version: '1.0.0' });
    clients.push(client);
    return client;
  }

  async function ping(client: Client) {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    return JSON.parse(content[0].text) as { pid: number; initializations: number; calls: number };
  }

  it('starts a separate worker and removes its process, state and lock on stop', async () => {
    const app = makeApp('bg-start-stop');
    const started = await app.start();
    expect(started.reused).toBe(false);
    expect(started.pid).not.toBe(process.pid);
    expect(await checkHealth(started.host, started.port, app.config.name)).toMatchObject({ ok: true, pid: started.pid });
    expect(await manager.adapter.status('mcponce-bg-start-stop')).toMatchObject({
      installed: true, running: true, pid: started.pid
    });
    await app.stop();
    expect(await checkHealth(started.host, started.port, app.config.name)).toBeNull();
    expect(new StateManager(app.config.dataDir).read()).toBeNull();
    expect(new LockManager(app.config.dataDir).hasLockFile()).toBe(false);
    expect(await manager.adapter.status('mcponce-bg-start-stop')).toMatchObject({ installed: false });
  });

  it('starts exactly one worker for ten concurrent clients and reuses it afterward', async () => {
    const concurrentApps = Array.from({ length: 10 }, () => makeApp('bg-concurrent'));
    const results = await Promise.all(concurrentApps.map((app) => app.start()));
    expect(new Set(results.map((result) => result.pid)).size).toBe(1);
    expect(new Set(results.map((result) => result.port)).size).toBe(1);
    expect(manager.adapter.install).toHaveBeenCalledTimes(1);
    const reused = await makeApp('bg-concurrent').start();
    expect(reused).toMatchObject({ reused: true, role: 'bridge', pid: results[0].pid, port: results[0].port });
    expect(manager.adapter.install).toHaveBeenCalledTimes(1);
  });

  it('keeps the worker and context alive after a real stdio client disconnects', async () => {
    const app = makeApp('bg-stdio');
    const started = await app.start();
    async function connectBridge() {
      const client = makeClient();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [app.config.entrypoint!],
        env: { MCPONCE_BACKGROUND_SERVER: '0', NODE_ENV: 'test' },
        stderr: 'pipe'
      });
      transport.stderr?.on('data', () => {});
      await client.connect(transport);
      expect(transport.pid).not.toBe(started.pid);
      return { client, transport };
    }
    const first = await connectBridge();
    expect(await ping(first.client)).toEqual({ pid: started.pid, initializations: 1, calls: 1 });
    const bridgePid = first.transport.pid!;
    await first.client.close();
    await expect.poll(() => {
      try { process.kill(bridgePid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }).toBe(true);
    expect(await checkHealth(started.host, started.port, app.config.name)).toMatchObject({ pid: started.pid });
    const second = await connectBridge();
    expect(await ping(second.client)).toEqual({ pid: started.pid, initializations: 1, calls: 2 });
    expect(manager.adapter.install).toHaveBeenCalledTimes(1);
  });

  it('shares one initialized context across independent HTTP MCP sessions', async () => {
    const app = makeApp('bg-http-context');
    const started = await app.start();
    const endpoint = new URL(`http://${started.host}:${started.port}/mcp`);
    const first = makeClient();
    const second = makeClient();
    await first.connect(new StreamableHTTPClientTransport(endpoint));
    await second.connect(new StreamableHTTPClientTransport(endpoint));
    expect(await ping(first)).toEqual({ pid: started.pid, initializations: 1, calls: 1 });
    expect(await ping(second)).toEqual({ pid: started.pid, initializations: 1, calls: 2 });
  });

  it('recovers the stale lock and state left by an actual worker crash', async () => {
    const app = makeApp('bg-crash');
    const first = await app.start();
    await manager.crash('mcponce-bg-crash');
    expect(new StateManager(app.config.dataDir).read()?.pid).toBe(first.pid);
    expect(new LockManager(app.config.dataDir).hasLockFile()).toBe(true);
    expect(await checkHealth(first.host, first.port, app.config.name)).toBeNull();
    const recovered = await app.start();
    expect(recovered.pid).not.toBe(first.pid);
    expect(recovered.reused).toBe(false);
    expect(manager.adapter.install).toHaveBeenCalledTimes(2);
    expect(await checkHealth(recovered.host, recovered.port, app.config.name)).toMatchObject({ pid: recovered.pid });
  });

  it('releases the startup lock on installation failure so a retry can succeed', async () => {
    const app = makeApp('bg-install-failure');
    manager.adapter.install.mockRejectedValueOnce(new Error('Service manager unavailable'));
    await expect(app.start()).rejects.toThrow('Service manager unavailable');
    expect(new LockManager(app.config.dataDir).hasLockFile()).toBe(false);
    expect(new StateManager(app.config.dataDir).read()).toBeNull();
    const retried = await app.start();
    expect(await checkHealth(retried.host, retried.port, app.config.name)).toMatchObject({ ok: true });
    expect(manager.adapter.install).toHaveBeenCalledTimes(2);
  });

  it('restarts with a new worker PID and fresh application context', async () => {
    const app = makeApp('bg-restart');
    const first = await app.start();
    const client = makeClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${first.host}:${first.port}/mcp`)));
    expect((await ping(client)).calls).toBe(1);
    await client.close();
    const restarted = await app.restart();
    expect(restarted.pid).not.toBe(first.pid);
    const newClient = makeClient();
    await newClient.connect(new StreamableHTTPClientTransport(new URL(`http://${restarted.host}:${restarted.port}/mcp`)));
    expect(await ping(newClient)).toEqual({ pid: restarted.pid, initializations: 1, calls: 1 });
    expect(manager.adapter.install).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct servers isolated when one is stopped', async () => {
    const first = makeApp('bg-isolated-a');
    const second = makeApp('bg-isolated-b');
    const [a, b] = await Promise.all([first.start(), second.start()]);
    expect(a.port).not.toBe(b.port);
    expect(a.pid).not.toBe(b.pid);
    expect(await checkHealth(b.host, b.port, first.config.name)).toBeNull();
    await first.stop();
    expect(await checkHealth(a.host, a.port, first.config.name)).toBeNull();
    expect(await checkHealth(b.host, b.port, second.config.name)).toMatchObject({ pid: b.pid });
  });

  it('supports a per-start background override on a foreground-configured app', async () => {
    const app = makeApp('bg-override', false);
    try {
      const started = await app.start({ background: true });
      expect(started.pid).not.toBe(process.pid);
      expect(await checkHealth(started.host, started.port, app.config.name)).toMatchObject({ ok: true });
    } finally {
      await app.stop({ background: true });
    }
  });

  it('fails before creating runtime state if the service manager cannot be loaded', async () => {
    const app = makeApp('bg-missing-manager');
    _setUnitupModule(null);
    await expect(app.start()).rejects.toThrow('Background mode requires Unitup');
    expect(manager.adapter.install).not.toHaveBeenCalled();
    expect(new LockManager(app.config.dataDir).hasLockFile()).toBe(false);
    expect(new StateManager(app.config.dataDir).read()).toBeNull();
  });
});
