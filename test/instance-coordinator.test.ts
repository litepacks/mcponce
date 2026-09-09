import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstanceCoordinator } from '../src/runtime/instance.js';
import type { ResolvedConfig } from '../src/runtime/config.js';
import * as healthModule from '../src/runtime/health.js';

describe('InstanceCoordinator (src/runtime/instance.ts)', () => {
  let tmpDir: string;
  let config: ResolvedConfig<any>;
  let mockLogger: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-instance-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    config = {
      name: 'coord-test-app',
      version: '1.0.0',
      dataDir: tmpDir,
      logDir: tmpDir,
      host: '127.0.0.1',
      port: 8080
    } as any;

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns role owner immediately when noSingleton is true', async () => {
    const coordinator = new InstanceCoordinator(config);
    const result = await coordinator.ensureInstance({ noSingleton: true });
    expect(result.role).toBe('owner');
  });

  it('discovers existing healthy instance on step 1 and returns role bridge', async () => {
    const coordinator = new InstanceCoordinator(config);
    coordinator.stateManager.write({
      name: config.name,
      version: '1.0.0',
      pid: 1234,
      port: 8080,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue({
      ok: true,
      status: 'ok',
      name: config.name
    } as any);

    const result = await coordinator.ensureInstance({ logger: mockLogger });
    expect(result.role).toBe('bridge');
    if (result.role === 'bridge') {
      expect(result.state.pid).toBe(1234);
    }
  });

  it('recovers from stale runtime state when PID is dead on step 1', async () => {
    const coordinator = new InstanceCoordinator(config);
    coordinator.stateManager.write({
      name: config.name,
      version: '1.0.0',
      pid: 99999,
      port: 8080,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(null);
    vi.spyOn(healthModule, 'isPidRunning').mockReturnValue(false);

    const result = await coordinator.ensureInstance({ logger: mockLogger });
    expect(result.role).toBe('owner');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Stale runtime state detected'),
      expect.anything()
    );
  });

  it('fast-path recovery when initial lock holder PID is dead or corrupt', async () => {
    const coordinator = new InstanceCoordinator(config);

    // Simulate an existing lock file with a dead pid
    coordinator.lockManager.tryAcquire(config.name);
    const lockData = coordinator.lockManager.readLock();

    vi.spyOn(healthModule, 'isPidRunning').mockReturnValue(false);
    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(null);

    const coordinator2 = new InstanceCoordinator(config);
    const result = await coordinator2.ensureInstance({ logger: mockLogger });
    expect(result.role).toBe('owner');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Detected dead lock holder or corrupted lock on startup'),
      expect.anything()
    );
  });

  it('discovers healthy instance during retry loop in step 3', async () => {
    const coordinator = new InstanceCoordinator(config);

    // Simulate another process holding the lock and starting
    coordinator.lockManager.tryAcquire(config.name);

    vi.spyOn(healthModule, 'isPidRunning').mockReturnValue(true);
    vi.spyOn(healthModule, 'checkHealth').mockImplementation(async (_h, _p, expectedName) => {
      return { ok: true, status: 'ok', name: expectedName } as any;
    });

    // Write state after 25ms to simulate startup in progress
    setTimeout(() => {
      coordinator.stateManager.write({
        name: config.name,
        version: '1.0.0',
        pid: 5678,
        port: 8085,
        host: '127.0.0.1',
        startedAt: new Date().toISOString()
      });
    }, 25);

    const coordinator2 = new InstanceCoordinator(config);
    const result = await coordinator2.ensureInstance({
      maxWaitMs: 2000,
      initialRetryDelayMs: 10,
      logger: mockLogger
    });

    expect(result.role).toBe('bridge');
    if (result.role === 'bridge') {
      expect(result.state.pid).toBe(5678);
    }
  });

  it('breaks early during retry loop when lock holder crashes and claims ownership', async () => {
    const coordinator = new InstanceCoordinator(config);
    coordinator.lockManager.tryAcquire(config.name);
    coordinator.stateManager.write({
      name: config.name,
      version: '1.0.0',
      pid: 1234,
      port: 8080,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    let isAliveCalls = 0;
    vi.spyOn(healthModule, 'isPidRunning').mockImplementation(() => {
      isAliveCalls++;
      // Return false on 2nd check during retry loop
      return isAliveCalls < 3;
    });
    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(null);

    const coordinator2 = new InstanceCoordinator(config);
    const result = await coordinator2.ensureInstance({
      maxWaitMs: 3000,
      initialRetryDelayMs: 10,
      logger: mockLogger
    });

    expect(result.role).toBe('owner');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Detected crashed or corrupt lock holder during wait'),
      expect.anything()
    );
  });

  it('discovers winner process in final post-recovery loop in step 4', async () => {
    const coordinator = new InstanceCoordinator(config);
    coordinator.lockManager.tryAcquire(config.name);

    vi.spyOn(healthModule, 'isPidRunning').mockReturnValue(true);
    vi.spyOn(healthModule, 'checkHealth').mockImplementation(async (_h, port, expectedName) => {
      if (port === 8089) {
        return { ok: true, status: 'ok', name: expectedName } as any;
      }
      return null;
    });

    // Simulate winning process writing state after timeout
    setTimeout(() => {
      coordinator.stateManager.write({
        name: config.name,
        version: '1.0.0',
        pid: 9999,
        port: 8089,
        host: '127.0.0.1',
        startedAt: new Date().toISOString()
      });
    }, 70);

    // Mock tryAcquire on recovery to fail (simulating another process won recovery race)
    const coordinator2 = new InstanceCoordinator(config);
    vi.spyOn(coordinator2.lockManager, 'tryAcquire').mockReturnValue(false);

    const result = await coordinator2.ensureInstance({
      maxWaitMs: 50,
      initialRetryDelayMs: 10,
      logger: mockLogger
    });

    expect(result.role).toBe('bridge');
    if (result.role === 'bridge') {
      expect(result.state.pid).toBe(9999);
    }
  });

  it('throws Error when lock acquisition and discovery both fail completely', async () => {
    const coordinator = new InstanceCoordinator(config);
    coordinator.lockManager.tryAcquire(config.name);

    vi.spyOn(healthModule, 'isPidRunning').mockReturnValue(true);
    vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(null);

    const coordinator2 = new InstanceCoordinator(config);
    vi.spyOn(coordinator2.lockManager, 'tryAcquire').mockReturnValue(false);

    await expect(
      coordinator2.ensureInstance({
        maxWaitMs: 50,
        initialRetryDelayMs: 10,
        logger: mockLogger
      })
    ).rejects.toThrow(/Failed to acquire server lock or discover healthy server/);
  });
});
