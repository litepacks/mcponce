import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';
import { checkHealth } from '../src/runtime/health.js';

describe('dynamic port allocation and discovery', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-port-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('allocates a dynamic port and persists it in runtime.json', async () => {
    const app = createMcpServer({
      name: 'port-app',
      dataDir: testDir,
      port: 0 // dynamic port
    });

    const result = await app.start();
    expect(result.port).toBeGreaterThan(0);
    expect(result.host).toBe('127.0.0.1');

    // Verify runtime.json
    const runtimePath = path.join(testDir, 'runtime.json');
    expect(fs.existsSync(runtimePath)).toBe(true);

    const state = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(state.port).toBe(result.port);
    expect(state.pid).toBe(process.pid);

    // Verify health check on the assigned dynamic port
    const health = await checkHealth('127.0.0.1', result.port, 'port-app', 1000);
    expect(health?.ok).toBe(true);
    expect(health?.name).toBe('port-app');

    // Verify app.status() reflects the dynamic port
    const status = await app.status();
    expect(status.status).toBe('running');
    if (status.status === 'running') {
      expect(status.port).toBe(result.port);
    }

    await app.stop();
  });

  it('rejects startHttpServer when server binding fails with error event', async () => {
    const { Hono } = await import('hono');
    const { startHttpServer } = await import('../src/transport/http.js');
    await expect(startHttpServer(new Hono(), '999.999.999.999', 80)).rejects.toThrow();
  });
});
