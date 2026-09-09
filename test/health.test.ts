import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { isPidRunning, checkHealth, fetchInfo } from '../src/runtime/health.js';

describe('health and PID checks', () => {
  let server: ServerType;
  let testPort: number;

  beforeAll(async () => {
    const app = new Hono();
    app.get('/health', (c) =>
      c.json({
        ok: true,
        name: 'health-test-app',
        pid: process.pid,
        version: '1.0.0'
      })
    );
    app.get('/health-fail', (c) => c.text('Server Error', 500));
    app.get('/health-not-ok', (c) => c.json({ ok: false, name: 'health-test-app' }));
    app.get('/info', (c) =>
      c.json({
        name: 'health-test-app',
        version: '1.0.0',
        pid: process.pid,
        role: 'owner',
        tools: ['test_tool']
      })
    );
    app.get('/info-fail', (c) => c.text('Not found', 404));

    await new Promise<void>((resolve) => {
      server = serve(
        {
          fetch: app.fetch,
          port: 0,
          hostname: '127.0.0.1'
        },
        (info) => {
          testPort = info.port;
          resolve();
        }
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('correctly detects that current PID is running and handles <= 0 PIDs', () => {
    expect(isPidRunning(process.pid)).toBe(true);
    expect(isPidRunning(0)).toBe(false);
    expect(isPidRunning(-10)).toBe(false);
  });

  it('handles EPERM errors when checking PID liveness', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      const err: any = new Error('Operation not permitted');
      err.code = 'EPERM';
      throw err;
    });

    expect(isPidRunning(1)).toBe(true);
    killSpy.mockRestore();
  });

  it('correctly detects that a non-existent PID is not running', () => {
    expect(isPidRunning(9999999)).toBe(false);
  });

  it('successfully returns health response when endpoint matches expected name', async () => {
    const health = await checkHealth('127.0.0.1', testPort, 'health-test-app', 1000);
    expect(health).not.toBeNull();
    expect(health?.ok).toBe(true);
    expect(health?.name).toBe('health-test-app');
    expect(health?.pid).toBe(process.pid);
  });

  it('returns null when health endpoint name does not match expected name or not ok', async () => {
    const health = await checkHealth('127.0.0.1', testPort, 'different-app', 1000);
    expect(health).toBeNull();
  });

  it('handles non-200 and closed port health check failures', async () => {
    const healthClosed = await checkHealth('127.0.0.1', 65530, 'health-test-app', 500);
    expect(healthClosed).toBeNull();

    // Mock fetch for non-ok response
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500
      } as any);
      expect(await checkHealth('127.0.0.1', testPort, 'health-test-app')).toBeNull();

      // Mock fetch for data.ok !== true
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, name: 'health-test-app' })
      } as any);
      expect(await checkHealth('127.0.0.1', testPort, 'health-test-app')).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('fetches info diagnostics or returns null on failure', async () => {
    const info = await fetchInfo('127.0.0.1', testPort);
    expect(info).not.toBeNull();
    expect(info?.name).toBe('health-test-app');
    expect(info?.version).toBe('1.0.0');

    // Closed port failure
    expect(await fetchInfo('127.0.0.1', 65530, 300)).toBeNull();

    // HTTP non-ok failure
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404
      } as any);
      expect(await fetchInfo('127.0.0.1', testPort)).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
