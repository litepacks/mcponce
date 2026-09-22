import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
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
  let originalExecArgv: string[];
  let originalArgv: string[];

  beforeEach(() => {
    originalExecArgv = process.execArgv;
    originalArgv = process.argv;
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
    process.execArgv = originalExecArgv;
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    _resetUnitupModule();
    vi.restoreAllMocks();
  });

  it('checks if Unitup is installed', async () => {
    expect(await isUnitupInstalled()).toBe(true);

    _setUnitupModule(null);
    expect(await isUnitupInstalled()).toBe(false);

    _resetUnitupModule();
    // Real import attempt
    expect(await isUnitupInstalled()).toBe(true);
    expect(await getUnitup()).toMatchObject({
      install: expect.any(Function), stop: expect.any(Function), uninstall: expect.any(Function)
    });
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
    process.execArgv = ['--import', '/workspace with spaces/tsx/loader.mjs'];
    await startBackgroundProcess({
      name: 'srv-test',
      command: '/bin/node',
      scriptPath: '/path with spaces/server.ts',
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
        args: ['--import', '/workspace with spaces/tsx/loader.mjs', '/path with spaces/server.ts', '--test', '--mcponce-background'],
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

  it('does not reinstall or stop a service when native restart succeeds', async () => {
    await restartBackgroundProcess({
      name: 'restart-app',
      dataDir: '/data',
      logDir: '/logs'
    });
    expect(mockUnitup.restart).toHaveBeenCalledWith('mcponce-restart-app');
    expect(mockUnitup.stop).not.toHaveBeenCalled();
    expect(mockUnitup.uninstall).not.toHaveBeenCalled();
    expect(mockUnitup.install).not.toHaveBeenCalled();
  });

  it('stops and uninstalls before reinstalling when native restart fails', async () => {
    mockUnitup.restart.mockRejectedValueOnce(new Error('Cannot restart service'));
    await restartBackgroundProcess({
      name: 'restart-app',
      dataDir: '/data',
      logDir: '/logs'
    });
    expect(mockUnitup.stop).toHaveBeenCalledWith('mcponce-restart-app');
    expect(mockUnitup.uninstall).toHaveBeenCalledWith('mcponce-restart-app', { force: true });
    expect(mockUnitup.install).toHaveBeenCalledTimes(1);
    expect(mockUnitup.stop.mock.invocationCallOrder[0]).toBeLessThan(mockUnitup.uninstall.mock.invocationCallOrder[0]);
    expect(mockUnitup.uninstall.mock.invocationCallOrder[0]).toBeLessThan(mockUnitup.install.mock.invocationCallOrder[0]);
  });

  it('retrieves background status or returns null on error', async () => {
    const st = await getBackgroundStatus('status-app');
    expect(st).toEqual({ status: 'running', pid: 1234 });

    mockUnitup.status.mockRejectedValueOnce(new Error('Service not found'));
    const nullSt = await getBackgroundStatus('status-app');
    expect(nullSt).toBeNull();
  });

  it('starts background process using process defaults when command and args are omitted', async () => {
    process.argv = ['node', '/workspace/server.mjs'];
    process.execArgv = [];
    await startBackgroundProcess({
      name: 'defaults-app',
      dataDir: '/var/data',
      logDir: '/var/logs'
    });

    expect(mockUnitup.install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcponce-defaults-app',
        command: process.execPath,
        cwd: process.cwd(),
        args: ['/workspace/server.mjs', '--mcponce-background'],
        logs: {
          stdout: path.join('/var/logs', 'unitup.stdout.log'),
          stderr: path.join('/var/logs', 'unitup.stderr.log')
        },
        start: true,
        force: true
      })
    );
  });

  it('merges custom env variables with MCPONCE_BACKGROUND_SERVER flag', async () => {
    vi.stubEnv('MCPONCE_TEST_INHERITED', 'parent');
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('MCPONCE_BACKGROUND_SERVER', '0');
    await startBackgroundProcess({
      name: 'env-merge-app',
      dataDir: '/data',
      logDir: '/logs',
      env: {
        CUSTOM_DATABASE_URL: 'postgres://localhost/test',
        APP_ENV: 'staging',
        MCPONCE_BACKGROUND_SERVER: '0'
      }
    });

    const installCall = mockUnitup.install.mock.calls.find(
      (c: any[]) => c[0].name === 'mcponce-env-merge-app'
    );
    expect(installCall).toBeDefined();
    expect(installCall[0].env.CUSTOM_DATABASE_URL).toBe('postgres://localhost/test');
    expect(installCall[0].env.APP_ENV).toBe('staging');
    expect(installCall[0].env.MCPONCE_BACKGROUND_SERVER).toBe('1');
    expect(installCall[0].env.MCPONCE_TEST_INHERITED).toBe('parent');
    expect(process.env.APP_ENV).toBe('development');
    expect(process.env.MCPONCE_BACKGROUND_SERVER).toBe('0');
  });

  it('propagates installation errors without reporting a successful start', async () => {
    const error = new Error('launchd rejected the service');
    mockUnitup.install.mockRejectedValueOnce(error);
    await expect(startBackgroundProcess({
      name: 'rejected-service', dataDir: '/data', logDir: '/logs'
    })).rejects.toBe(error);
    expect(mockUnitup.install).toHaveBeenCalledTimes(1);
  });

  it('handles partial stop failure gracefully (stop throws, but uninstall succeeds)', async () => {
    mockUnitup.stop.mockRejectedValueOnce(new Error('Process already stopped'));
    const ok = await stopBackgroundProcess('partially-stopped');
    expect(ok).toBe(true);
    expect(mockUnitup.uninstall).toHaveBeenCalledWith('mcponce-partially-stopped', { force: true });
  });

  it('propagates error when both restart and fallback install fail', async () => {
    mockUnitup.restart.mockRejectedValueOnce(new Error('Service restart failed'));
    mockUnitup.install.mockRejectedValueOnce(new Error('Service fallback install failed'));

    await expect(
      restartBackgroundProcess({
        name: 'failing-restart-app',
        dataDir: '/data',
        logDir: '/logs'
      })
    ).rejects.toThrow('Service fallback install failed');
  });

  it('getBackgroundStatus returns null when status throws a non-Error exception', async () => {
    mockUnitup.status.mockRejectedValueOnce('raw string error message');
    const st = await getBackgroundStatus('non-error-status');
    expect(st).toBeNull();
  });
});
