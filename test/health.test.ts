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

  it('checkHealth returns null when endpoint returns non-object JSON (array, primitive number, string)', async () => {
    const origFetch = globalThis.fetch;
    try {
      // 1. Array JSON
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [1, 2, 3]
      } as any);
      expect(await checkHealth('127.0.0.1', testPort, 'health-test-app')).toBeNull();

      // 2. Primitive number JSON
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => 42
      } as any);
      expect(await checkHealth('127.0.0.1', testPort, 'health-test-app')).toBeNull();

      // 3. String JSON
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => 'healthy'
      } as any);
      expect(await checkHealth('127.0.0.1', testPort, 'health-test-app')).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('checkHealth handles request timeouts and connection aborts', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockImplementationOnce(async () => {
        const err: any = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      });
      const res = await checkHealth('127.0.0.1', testPort, 'health-test-app', 50);
      expect(res).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('fetchInfo handles non-JSON HTML error pages without crashing', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true, // e.g. a misconfigured proxy returning 200 with HTML error body
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        }
      } as any);
      const info = await fetchInfo('127.0.0.1', testPort);
      expect(info).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('fetchInfo handles HTTP 500 internal server error', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500
      } as any);
      const info = await fetchInfo('127.0.0.1', testPort);
      expect(info).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('isPidRunning handles NaN, Infinity, null/undefined, and extreme values', () => {
    expect(isPidRunning(NaN)).toBe(false);
    expect(isPidRunning(Infinity as any)).toBe(false);
    expect(isPidRunning(-Infinity as any)).toBe(false);
    expect(isPidRunning(undefined as any)).toBe(false);
    expect(isPidRunning(null as any)).toBe(false);
  });

  it('checkHealth returns null when ok is true but name is missing', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, pid: 1234 }) // missing name
      } as any);
      const res = await checkHealth('127.0.0.1', testPort, 'expected-app');
      expect(res).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
