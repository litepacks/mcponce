import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';
import { checkHealth } from '../src/runtime/health.js';

describe('stale runtime state and crash recovery', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('safely recovers when runtime.json points to a dead PID', async () => {
    // Simulate dead process state
    const staleState = {
      name: 'stale-app',
      version: '1.0.0',
      pid: 9999999,
      port: 59999,
      host: '127.0.0.1',
      startedAt: '2020-01-01T00:00:00.000Z'
    };
    fs.writeFileSync(path.join(testDir, 'runtime.json'), JSON.stringify(staleState));

    const staleLock = {
      pid: 9999999,
      name: 'stale-app',
      createdAt: '2020-01-01T00:00:00.000Z'
    };
    fs.writeFileSync(path.join(testDir, 'instance.lock'), JSON.stringify(staleLock));

    const app = createMcpServer({
      name: 'stale-app',
      dataDir: testDir,
      port: 0
    });

    const result = await app.start();
    expect(result.role).toBe('owner');
    expect(result.reused).toBe(false);
    expect(result.pid).toBe(process.pid);

    const health = await checkHealth('127.0.0.1', result.port, 'stale-app');
    expect(health?.ok).toBe(true);
    expect(health?.pid).toBe(process.pid);

    await app.stop();
  });

  it('safely recovers when runtime.json is corrupt', async () => {
    fs.writeFileSync(path.join(testDir, 'runtime.json'), '{corrupt-json-truncated}');

    const app = createMcpServer({
      name: 'corrupt-app',
      dataDir: testDir,
      port: 0
    });

    const result = await app.start();
    expect(result.role).toBe('owner');
    expect(result.reused).toBe(false);

    await app.stop();
  });

  it('safely recovers when the previous server crashed without unlinking files', async () => {
    // Start instance 1
    const app1 = createMcpServer({
      name: 'crash-app',
      dataDir: testDir,
      port: 0
    });
    const res1 = await app1.start();
    expect(res1.role).toBe('owner');

    // Simulate crash: stop HTTP server without cleaning lock or runtime files
    // (e.g. by stopping server socket but leaving files on disk, or setting fake dead PID)
    await (app1 as any).httpHandle.close();

    // Overwrite the files with a dead PID to simulate process death
    fs.writeFileSync(
      path.join(testDir, 'instance.lock'),
      JSON.stringify({ pid: 9999998, name: 'crash-app', createdAt: new Date().toISOString() })
    );
    fs.writeFileSync(
      path.join(testDir, 'runtime.json'),
      JSON.stringify({
        name: 'crash-app',
        version: '1.0.0',
        pid: 9999998,
        port: res1.port,
        host: '127.0.0.1',
        startedAt: new Date().toISOString()
      })
    );

    // Instance 2 attempts to start
    const app2 = createMcpServer({
      name: 'crash-app',
      dataDir: testDir,
      port: 0
    });

    const res2 = await app2.start();
    expect(res2.role).toBe('owner');
    expect(res2.reused).toBe(false);
    expect(res2.pid).toBe(process.pid);

    const health = await checkHealth('127.0.0.1', res2.port, 'crash-app');
    expect(health?.ok).toBe(true);

    await app2.stop();
  });
});
