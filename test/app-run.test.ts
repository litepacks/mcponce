import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';
import { StateManager } from '../src/runtime/state.js';
import * as healthModule from '../src/runtime/health.js';
import * as unitupModule from '../src/runtime/unitup.js';

vi.mock('../src/transport/proxy.js', () => ({
  startStdioProxy: () => {
    return Promise.resolve({
      done: new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      }),
      close: () => Promise.resolve()
    });
  }
}));

describe('McpApp.run() lifecycle branches', () => {
  let tmpDir: string;
  let dataDir: string;
  let logDir: string;
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;
  let processExitSpy: any;
  let processStderrSpy: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-app-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dataDir = path.join(tmpDir, 'data');
    logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    originalArgv = [...process.argv];
    originalEnv = { ...process.env };

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    processStderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits early when a CLI command is executed', async () => {
    process.argv = ['node', 'server.js', 'help'];
    const app = createMcpServer({
      name: 'cli-exit-test',
      dataDir,
      logDir,
      port: 0
    });

    const startSpy = vi.spyOn(app, 'start');
    await app.run();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('runs as background worker when MCPONCE_BACKGROUND_SERVER is 1', async () => {
    process.env.MCPONCE_BACKGROUND_SERVER = '1';
    process.argv = ['node', 'server.js'];

    const app = createMcpServer({
      name: 'bg-worker-test',
      dataDir,
      logDir,
      port: 0
    });

    await app.run();
    expect((app as any).httpHandle).toBeDefined();
    await app.stop();
  });

  it('runs in devMode writing diagnostic logs to stderr', async () => {
    process.argv = ['node', 'server.js', '--dev', '--no-singleton'];

    const app = createMcpServer({
      name: 'dev-mode-test',
      dataDir,
      logDir,
      port: 0
    });

    await app.run();
    expect(processStderrSpy).toHaveBeenCalledWith(expect.stringContaining('[dev-mode-test] Starting in development mode'));
    await app.stop();
  });

  it('runs in background client bridge mode with existing healthy server', async () => {
    process.argv = ['node', 'server.js', '--background'];

    const app = createMcpServer({
      name: 'bg-bridge-healthy-test',
      dataDir,
      logDir,
      port: 0
    });

    const sm = new StateManager(dataDir);
    sm.write({
      name: 'bg-bridge-healthy-test',
      version: '1.0.0',
      pid: 4321,
      port: 9999,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    vi.spyOn(unitupModule, 'getUnitup').mockResolvedValue({} as any);
    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue({ ok: true, status: 'ok', name: 'bg-bridge-healthy-test' } as any);

    await app.run();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('runs in background client bridge mode starting new background server when stale or absent', async () => {
    process.argv = ['node', 'server.js', '--background', '--dev'];

    const app = createMcpServer({
      name: 'bg-bridge-spawn-test',
      dataDir,
      logDir,
      port: 0
    });

    const sm = new StateManager(dataDir);
    sm.write({
      name: 'bg-bridge-spawn-test',
      version: '1.0.0',
      pid: 99999,
      port: 9998,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    vi.spyOn(unitupModule, 'getUnitup').mockResolvedValue({} as any);
    const startBgSpy = vi.spyOn(unitupModule, 'startBackgroundProcess').mockImplementation(async () => {
      // Simulate spawned server writing fresh state
      sm.write({
        name: 'bg-bridge-spawn-test',
        version: '1.0.0',
        pid: 7777,
        port: 8888,
        host: '127.0.0.1',
        startedAt: new Date().toISOString()
      });
    });

    vi.spyOn(healthModule, 'checkHealth').mockImplementation(async (_host, port) => {
      if (port === 8888) {
        return { ok: true, status: 'ok', name: 'bg-bridge-spawn-test' } as any;
      }
      return null;
    });

    await app.run();
    expect(startBgSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('runs as single-instance owner with central registry and cleans up on exit', async () => {
    process.argv = ['node', 'server.js', '--no-singleton'];

    const app = createMcpServer({
      name: 'owner-run-test',
      dataDir,
      logDir,
      port: 0,
      registerInCentral: true
    });

    await app.run();
    expect((app as any).httpHandle).toBeDefined();

    // Trigger process exit hook
    process.emit('exit', 0);
    await app.stop();
  });

  it('runs as bridge when coordinator assigns role bridge', async () => {
    process.argv = ['node', 'server.js', '--dev'];

    const app = createMcpServer({
      name: 'bridge-run-test',
      dataDir,
      logDir,
      port: 0
    });

    vi.spyOn((app as any).instanceCoordinator, 'ensureInstance').mockResolvedValue({
      role: 'bridge',
      state: {
        name: 'bridge-run-test',
        pid: 2222,
        port: 7777,
        host: '127.0.0.1'
      }
    });

    await app.run();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('keeps HTTP server alive when owner stdio closes if active sessions exist', async () => {
    process.argv = ['node', 'server.js', '--no-singleton'];

    const app = createMcpServer({
      name: 'owner-keepalive-test',
      dataDir,
      logDir,
      port: 0
    });

    // Add dummy active session
    (app as any).sessions.set('sess-1', { id: 'sess-1' });

    await app.run();
    expect((app as any).httpHandle).toBeDefined();
    await app.stop();
  });
});
