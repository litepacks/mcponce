import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CentralRegistry } from '../src/registry/central.js';
import { createMcpServer } from '../src/index.js';

describe('CentralRegistry (servers.json)', () => {
  let testDir: string;
  let registryPath: string;
  let registry: CentralRegistry;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-central-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    registryPath = path.join(testDir, 'servers.json');
    registry = new CentralRegistry(registryPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('registers a server and writes to servers.json', async () => {
    await registry.register({
      name: 'test-srv',
      version: '1.0.0',
      status: 'running',
      pid: process.pid,
      port: 50000,
      host: '127.0.0.1',
      dataDir: path.join(testDir, 'data'),
      logDir: path.join(testDir, 'logs')
    });

    expect(fs.existsSync(registryPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(content.servers['test-srv']).toBeDefined();
    expect(content.servers['test-srv'].name).toBe('test-srv');
    expect(content.servers['test-srv'].status).toBe('running');
  });

  it('reconciles dead servers to stopped on getAll()', async () => {
    // Register a server with a dead PID
    await registry.register({
      name: 'dead-srv',
      version: '1.0.0',
      status: 'running',
      pid: 9999999, // non-existent PID
      port: 59999,
      host: '127.0.0.1',
      dataDir: path.join(testDir, 'data'),
      logDir: path.join(testDir, 'logs')
    });

    const servers = await registry.getAll(true);
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe('dead-srv');
    expect(servers[0].status).toBe('stopped');
    expect(servers[0].pid).toBeUndefined();

    // Verify persisted back to file
    const content = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(content.servers['dead-srv'].status).toBe('stopped');
  });

  it('cleans stopped servers from servers.json', async () => {
    await registry.register({
      name: 'srv-1',
      version: '1.0.0',
      status: 'stopped',
      dataDir: testDir,
      logDir: testDir
    });

    await registry.register({
      name: 'srv-2',
      version: '1.0.0',
      status: 'stopped',
      dataDir: testDir,
      logDir: testDir
    });

    const removed = await registry.clean();
    expect(removed).toBe(2);

    const remaining = await registry.getAll(false);
    expect(remaining.length).toBe(0);
  });

  it('automatically registers and unregisters an McpApp when started and stopped', async () => {
    process.env.MCPONCE_REGISTRY_PATH = registryPath;

    const app = createMcpServer({
      name: 'auto-reg-app',
      dataDir: path.join(testDir, 'auto-app-data'),
      port: 0
    });

    const startResult = await app.start();
    expect(startResult.role).toBe('owner');

    // Central registry should have recorded it as running
    const regServer = await registry.get('auto-reg-app');
    expect(regServer).not.toBeNull();
    expect(regServer?.status).toBe('running');
    expect(regServer?.port).toBe(startResult.port);

    const allRunning = await registry.getAll(true);
    expect(allRunning.some(s => s.name === 'auto-reg-app' && s.status === 'running')).toBe(true);

    // Stopping the app
    await app.stop();

    // Central registry should mark it stopped
    const stoppedServer = await registry.get('auto-reg-app');
    expect(stoppedServer?.status).toBe('stopped');

    delete process.env.MCPONCE_REGISTRY_PATH;
  });

  it('runs completely standalone without touching registry when registerInCentral is false', async () => {
    process.env.MCPONCE_REGISTRY_PATH = registryPath;

    const standaloneApp = createMcpServer({
      name: 'standalone-isolated-app',
      dataDir: path.join(testDir, 'isolated-data'),
      port: 0,
      registerInCentral: false
    });

    const startResult = await standaloneApp.start();
    expect(startResult.role).toBe('owner');

    // Registry should be completely unaware of this server
    const regServer = await registry.get('standalone-isolated-app');
    expect(regServer).toBeNull();

    await standaloneApp.stop();

    delete process.env.MCPONCE_REGISTRY_PATH;
  });

  it('covers path getter and default constructor behavior', () => {
    expect(registry.path).toBe(registryPath);

    const oldEnv = process.env.MCPONCE_REGISTRY_PATH;
    delete process.env.MCPONCE_REGISTRY_PATH;
    const defaultReg = new CentralRegistry();
    expect(defaultReg.path).toContain('servers.json');

    process.env.MCPONCE_REGISTRY_PATH = registryPath;
    const envReg = new CentralRegistry();
    expect(envReg.path).toBe(registryPath);
    if (oldEnv) process.env.MCPONCE_REGISTRY_PATH = oldEnv;
    else delete process.env.MCPONCE_REGISTRY_PATH;
  });

  it('recovers gracefully from corrupt JSON or invalid file format', async () => {
    fs.writeFileSync(registryPath, '{ broken json', 'utf-8');
    const servers1 = await registry.getAll(false);
    expect(servers1).toEqual([]);

    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, servers: null }), 'utf-8');
    const servers2 = await registry.getAll(false);
    expect(servers2).toEqual([]);
  });

  it('handles updateStatus for unknown servers gracefully', async () => {
    await registry.updateStatus('unknown-srv', 'stopped');
    const s = await registry.get('unknown-srv');
    expect(s).toBeNull();
  });

  it('removes an existing and non-existing server via remove()', async () => {
    await registry.register({
      name: 'srv-to-remove',
      version: '1.0.0',
      status: 'stopped',
      dataDir: testDir,
      logDir: testDir
    });

    const removed = await registry.remove('srv-to-remove');
    expect(removed).toBe(true);

    const removedAgain = await registry.remove('srv-to-remove');
    expect(removedAgain).toBe(false);
  });

  it('stops a server or returns false if not running', async () => {
    expect(await registry.stop('non-existent')).toBe(false);

    await registry.register({
      name: 'stopped-srv',
      version: '1.0.0',
      status: 'stopped',
      dataDir: testDir,
      logDir: testDir
    });
    expect(await registry.stop('stopped-srv')).toBe(false);

    // Running server mocked
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.spyOn(registry, 'get').mockResolvedValueOnce({
      name: 'running-mock-srv',
      version: '1.0.0',
      status: 'running',
      pid: 12345,
      dataDir: testDir,
      logDir: testDir
    });

    const stopResult = await registry.stop('running-mock-srv');
    expect(stopResult).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('reconciles dead server during get()', async () => {
    await registry.register({
      name: 'dead-on-get',
      version: '1.0.0',
      status: 'running',
      pid: 9999999,
      port: 59999,
      host: '127.0.0.1',
      dataDir: testDir,
      logDir: testDir
    });

    const s = await registry.get('dead-on-get');
    expect(s?.status).toBe('stopped');
    expect(s?.pid).toBeUndefined();
  });
});
