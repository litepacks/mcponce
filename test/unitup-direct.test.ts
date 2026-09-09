import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _setUnitupModule,
  _resetUnitupModule,
  isUnitupInstalled,
  getUnitup,
  getUnitupServiceName,
  startBackgroundProcess,
  stopBackgroundProcess,
  restartBackgroundProcess,
  getBackgroundStatus
} from '../src/runtime/unitup.js';

describe('Unitup Runtime Helper (src/runtime/unitup.ts)', () => {
  let mockUnitup: any;

  beforeEach(() => {
    mockUnitup = {
      install: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ status: 'running', pid: 1234 })
    };
    _setUnitupModule(mockUnitup);
  });

  afterEach(() => {
    _resetUnitupModule();
    vi.restoreAllMocks();
  });

  it('checks if Unitup is installed', async () => {
    expect(await isUnitupInstalled()).toBe(true);

    _setUnitupModule(null);
    expect(await isUnitupInstalled()).toBe(false);

    _resetUnitupModule();
    // Real import attempt
    const installed = await isUnitupInstalled();
    expect(typeof installed).toBe('boolean');
  });

  it('getUnitup returns module or throws friendly error', async () => {
    expect(await getUnitup()).toBe(mockUnitup);

    _setUnitupModule(null);
    await expect(getUnitup()).rejects.toThrow('Background mode requires Unitup, but Unitup is not installed');
  });

  it('generates service name', () => {
    expect(getUnitupServiceName('my-app')).toBe('mcponce-my-app');
  });

  it('starts background process with custom options and defaults', async () => {
    await startBackgroundProcess({
      name: 'srv-test',
      command: '/bin/node',
      scriptPath: '/path/server.js',
      cwd: '/cwd',
      env: { CUSTOM_VAR: '1' },
      args: ['--test'],
      dataDir: '/data',
      logDir: '/logs'
    });

    expect(mockUnitup.install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcponce-srv-test',
        command: '/bin/node',
        cwd: '/cwd',
        start: true,
        force: true
      })
    );
  });

  it('stops background process and handles errors gracefully', async () => {
    const ok = await stopBackgroundProcess('srv-test');
    expect(ok).toBe(true);
    expect(mockUnitup.stop).toHaveBeenCalledWith('mcponce-srv-test');
    expect(mockUnitup.uninstall).toHaveBeenCalledWith('mcponce-srv-test', { force: true });

    _setUnitupModule(null);
    const fail = await stopBackgroundProcess('srv-test');
    expect(fail).toBe(false);
  });

  it('restarts background process with fallback on failure', async () => {
    await restartBackgroundProcess({
      name: 'restart-app',
      dataDir: '/data',
      logDir: '/logs'
    });
    expect(mockUnitup.restart).toHaveBeenCalledWith('mcponce-restart-app');

    // Test fallback path when restart throws
    mockUnitup.restart.mockRejectedValueOnce(new Error('Cannot restart service'));
    await restartBackgroundProcess({
      name: 'restart-app',
      dataDir: '/data',
      logDir: '/logs'
    });
    expect(mockUnitup.stop).toHaveBeenCalled();
    expect(mockUnitup.install).toHaveBeenCalled();
  });

  it('retrieves background status or returns null on error', async () => {
    const st = await getBackgroundStatus('status-app');
    expect(st).toEqual({ status: 'running', pid: 1234 });

    mockUnitup.status.mockRejectedValueOnce(new Error('Service not found'));
    const nullSt = await getBackgroundStatus('status-app');
    expect(nullSt).toBeNull();
  });
});
