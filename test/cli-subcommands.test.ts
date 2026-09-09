import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { printInfo } from '../src/cli/info.js';
import { printLogs } from '../src/cli/logs.js';
import { fetchAnalytics, printAnalytics } from '../src/cli/analytics.js';
import { handleCliArgs } from '../src/cli/index.js';
import { StateManager } from '../src/runtime/state.js';
import type { ResolvedConfig } from '../src/runtime/config.js';
import * as healthModule from '../src/runtime/health.js';
import * as browserModule from '../src/utils/browser.js';
import * as installerModule from '../src/cli/installer.js';
import * as toolCallerModule from '../src/cli/tool-caller.js';

describe('CLI Subcommands & Handlers', () => {
  let tmpDir: string;
  let logDir: string;
  let dataDir: string;
  let config: ResolvedConfig<any>;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dataDir = path.join(tmpDir, 'data');
    logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    config = {
      name: 'test-server',
      version: '1.2.3',
      host: '127.0.0.1',
      port: 8080,
      transport: 'sse',
      dataDir,
      logDir,
      entrypoint: '/path/to/server.js'
    } as unknown as ResolvedConfig<any>;

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('printInfo', () => {
    it('prints stopped status when no state file exists', async () => {
      await printInfo(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Status: stopped');
      expect(logs).toContain(`Data directory: ${config.dataDir}`);
    });

    it('prints stale status when state exists but health check fails', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 99999,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: new Date().toISOString()
      });

      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(false);

      await printInfo(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Status: stopped (stale state found for pid 99999)');
    });

    it('prints full running details when healthy and info is available', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-09-09T12:00:00.000Z'
      });

      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(true);
      vi.spyOn(healthModule, 'fetchInfo').mockResolvedValue({
        activeSessions: 2,
        totalSessions: 10,
        lastClientConnection: '2026-09-09T12:05:00.000Z',
        lastToolInvocation: {
          name: 'add',
          timestamp: '2026-09-09T12:06:00.000Z'
        },
        analytics: {
          totalInvocations: 15,
          successfulInvocations: 14,
          failedInvocations: 1,
          averageExecutionTimeMs: 42
        }
      } as any);

      await printInfo(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Status: running');
      expect(logs).toContain('PID: 1234');
      expect(logs).toContain('Active sessions: 2');
      expect(logs).toContain('Total sessions: 10');
      expect(logs).toContain('Last connection: 2026-09-09T12:05:00.000Z');
      expect(logs).toContain('Last tool invocation: add at 2026-09-09T12:06:00.000Z');
      expect(logs).toContain('Tool calls: 15 (14 ok, 1 err, avg 42ms)');
    });

    it('handles running state when fetchInfo returns null', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-09-09T12:00:00.000Z'
      });

      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(true);
      vi.spyOn(healthModule, 'fetchInfo').mockResolvedValue(null as any);

      await printInfo(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Status: running');
      expect(logs).toContain('Active sessions: unknown');
      expect(logs).toContain('Total sessions: unknown');
    });
  });

  describe('printLogs', () => {
    it('prints message if current.log does not exist', async () => {
      await printLogs(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No logs found yet.');
    });

    it('prints recent lines from current.log respecting limit', async () => {
      const logFile = path.join(logDir, 'current.log');
      const lines = Array.from({ length: 10 }, (_, i) => `Log line ${i + 1}`).join('\n');
      fs.writeFileSync(logFile, lines, 'utf-8');

      await printLogs(config, 3);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Recent logs (3 lines)');
      expect(logs).toContain('Log line 8');
      expect(logs).toContain('Log line 9');
      expect(logs).toContain('Log line 10');
      expect(logs).not.toContain('Log line 1\n');
    });
  });

  describe('fetchAnalytics & printAnalytics', () => {
    it('fetchAnalytics returns parsed json on success', async () => {
      const mockData = { startedAt: '2026-01-01', summary: {} };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockData
      } as any);

      const res = await fetchAnalytics('127.0.0.1', 8080);
      expect(res).toEqual(mockData);
      globalThis.fetch = originalFetch;
    });

    it('fetchAnalytics returns null on 404 or error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false
      } as any);

      const res = await fetchAnalytics('127.0.0.1', 8080);
      expect(res).toBeNull();

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
      const res2 = await fetchAnalytics('127.0.0.1', 8080);
      expect(res2).toBeNull();
      globalThis.fetch = originalFetch;
    });

    it('printAnalytics shows stopped message if no state file', async () => {
      await printAnalytics(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain(`Server "${config.name}" is stopped.`);
    });

    it('printAnalytics shows stale message if health check fails', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 8888,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-01-01'
      });
      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(false);

      await printAnalytics(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('stale state found for PID 8888');
    });

    it('printAnalytics shows failure message if fetchAnalytics returns null', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 8888,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-01-01'
      });
      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(true);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));

      await printAnalytics(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Failed to retrieve analytics');
      globalThis.fetch = originalFetch;
    });

    it('printAnalytics prints rich tables, summaries, call graphs, and recent invocations', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 8888,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-01-01'
      });
      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(true);

      const mockAnalytics = {
        startedAt: '2026-09-09T10:00:00.000Z',
        summary: {
          totalInvocations: 10,
          successfulInvocations: 8,
          failedInvocations: 1,
          timeoutInvocations: 1,
          cancelledInvocations: 0,
          averageExecutionTimeMs: 25,
          totalExecutionTimeMs: 250,
          totalInterToolCalls: 2
        },
        tools: {
          calculate: {
            name: 'calculate',
            calls: 6,
            success: 6,
            errors: 0,
            avgDurationMs: 12,
            minDurationMs: 5,
            maxDurationMs: 20
          },
          failing: {
            name: 'failing',
            calls: 4,
            success: 2,
            errors: 2,
            avgDurationMs: 40,
            minDurationMs: 10,
            maxDurationMs: 100
          }
        },
        interToolCalls: [
          { caller: 'orchestrator', target: 'calculate', count: 5 }
        ],
        recentInvocations: [
          {
            timestamp: '2026-09-09T12:00:01.000Z',
            tool: 'calculate',
            caller: 'user',
            durationMs: 10,
            status: 'success'
          },
          {
            timestamp: '2026-09-09T12:00:02.000Z',
            tool: 'failing',
            durationMs: 50,
            status: 'error',
            errorMessage: 'Division by zero'
          },
          {
            timestamp: '2026-09-09T12:00:03.000Z',
            tool: 'slow',
            durationMs: 500,
            status: 'timeout'
          },
          {
            timestamp: '2026-09-09T12:00:04.000Z',
            tool: 'aborted',
            durationMs: 15,
            status: 'cancelled'
          }
        ]
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockAnalytics
      } as any);

      await printAnalytics(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');

      expect(logs).toContain('mcponce Analytics: test-server');
      expect(logs).toContain('Success Rate:          80%');
      expect(logs).toContain('1 timed out');
      expect(logs).toContain('calculate');
      expect(logs).toContain('failing');
      expect(logs).toContain('orchestrator ──(5x)──> calculate');
      expect(logs).toContain('✓ OK');
      expect(logs).toContain('[✗ ERROR] - Division by zero');
      expect(logs).toContain('⏱ TIMEOUT');
      expect(logs).toContain('🛑 CANCEL');

      globalThis.fetch = originalFetch;
    });

    it('printAnalytics handles 0 invocations and empty tools cleanly', async () => {
      const sm = new StateManager(dataDir);
      sm.write({
        pid: 8888,
        port: 8080,
        host: '127.0.0.1',
        name: config.name,
        startedAt: '2026-01-01'
      });
      vi.spyOn(healthModule, 'checkHealth').mockResolvedValue(true);

      const emptyAnalytics = {
        startedAt: '2026-09-09T10:00:00.000Z',
        summary: {
          totalInvocations: 0,
          successfulInvocations: 0,
          failedInvocations: 0,
          timeoutInvocations: 0,
          cancelledInvocations: 0,
          averageExecutionTimeMs: 0,
          totalExecutionTimeMs: 0,
          totalInterToolCalls: 0
        },
        tools: {},
        interToolCalls: [],
        recentInvocations: []
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => emptyAnalytics
      } as any);

      await printAnalytics(config);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Success Rate:          100%');
      expect(logs).toContain('No tool invocations recorded yet.');
      globalThis.fetch = originalFetch;
    });
  });

  describe('handleCliArgs', () => {
    it('handles help flags', async () => {
      for (const flag of ['help', '--help', '-h']) {
        const res = await handleCliArgs([flag], config);
        expect(res.isCliCommand).toBe(true);
      }
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Usage: test-server [command|options]');
    });

    it('handles version flags', async () => {
      for (const flag of ['version', '--version', '-v']) {
        const res = await handleCliArgs([flag], config);
        expect(res.isCliCommand).toBe(true);
      }
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('test-server v1.2.3');
    });

    it('handles install command and errors', async () => {
      const installSpy = vi.spyOn(installerModule, 'installClientConfig').mockReturnValue([
        {
          client: 'claude',
          configPath: '/mock/path',
          serverEntry: { command: 'node', args: ['server.js'] }
        }
      ]);

      const res = await handleCliArgs(['install', 'cursor', '--dry-run', '--project', '--config-path', '/custom/cfg'], config);
      expect(res.isCliCommand).toBe(true);
      expect(installSpy).toHaveBeenCalledWith({
        serverName: config.name,
        entrypoint: config.entrypoint,
        client: 'cursor',
        background: true,
        project: true,
        dryRun: true,
        customPath: '/custom/cfg'
      });

      // Test error branch
      installSpy.mockImplementation(() => {
        throw new Error('Install failed intentionally');
      });
      await expect(handleCliArgs(['install'], config)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to install client config:', 'Install failed intentionally');
    });

    it('handles uninstall command and errors', async () => {
      const uninstallSpy = vi.spyOn(installerModule, 'uninstallClientConfig').mockReturnValue([
        { client: 'claude', configPath: '/mock/c', removed: true },
        { client: 'cursor', configPath: '/mock/u', removed: false }
      ]);

      const res = await handleCliArgs(['uninstall', 'all', '--dry-run', '--config-path', '/p'], config);
      expect(res.isCliCommand).toBe(true);
      expect(uninstallSpy).toHaveBeenCalled();

      // Test error branch
      uninstallSpy.mockImplementation(() => {
        throw new Error('Uninstall failed');
      });
      await expect(handleCliArgs(['uninstall'], config)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to uninstall client config:', 'Uninstall failed');
    });

    it('handles call command with and without app', async () => {
      // Without app
      await expect(handleCliArgs(['call', 'add', 'a=1'], config, undefined)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Tool execution requires an active application instance.');

      // With app
      const callSpy = vi.spyOn(toolCallerModule, 'executeCliToolCall').mockResolvedValue(undefined as any);
      const mockApp = {};
      const res = await handleCliArgs(['call', 'calc', 'x=10'], config, mockApp);
      expect(res.isCliCommand).toBe(true);
      expect(callSpy).toHaveBeenCalledWith(mockApp, 'calc', ['x=10']);
    });

    it('handles tools command with and without app', async () => {
      // Without app
      await expect(handleCliArgs(['tools'], config, undefined)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Listing tools requires an active application instance.');

      // With app
      const listSpy = vi.spyOn(toolCallerModule, 'printToolsList').mockImplementation(() => {});
      const mockApp = { getTools: () => [{ name: 'test-tool' }] };
      const res = await handleCliArgs(['tools'], config, mockApp);
      expect(res.isCliCommand).toBe(true);
      expect(listSpy).toHaveBeenCalledWith([{ name: 'test-tool' }]);

      // list-tools alias without getTools method
      const mockAppNoGetTools = {};
      await handleCliArgs(['list-tools'], config, mockAppNoGetTools);
      expect(listSpy).toHaveBeenCalledWith([]);
    });

    it('handles info, analytics, logs commands', async () => {
      const resInfo = await handleCliArgs(['info'], config);
      expect(resInfo.isCliCommand).toBe(true);

      const resAnalytics = await handleCliArgs(['analytics'], config);
      expect(resAnalytics.isCliCommand).toBe(true);

      const resLogs = await handleCliArgs(['logs', '25'], config);
      expect(resLogs.isCliCommand).toBe(true);

      const resLogsNaN = await handleCliArgs(['logs', 'invalid'], config);
      expect(resLogsNaN.isCliCommand).toBe(true);
    });

    it('handles inspect command with and without app and flags', async () => {
      // Without app
      await expect(handleCliArgs(['inspect'], config, undefined)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Inspect command requires an active application instance.');

      // With app
      const openBrowserSpy = vi.spyOn(browserModule, 'openBrowser').mockResolvedValue(true);
      const mockApp = {
        start: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 9000 }),
        getInspectorUrl: vi.fn().mockReturnValue('http://127.0.0.1:9000/inspect')
      };

      // With browser open
      const res = await handleCliArgs(['inspect'], config, mockApp);
      expect(res.isCliCommand).toBe(true);
      expect(openBrowserSpy).toHaveBeenCalledWith('http://127.0.0.1:9000/inspect');

      // With --no-open
      openBrowserSpy.mockClear();
      await handleCliArgs(['inspect', '--no-open'], config, mockApp);
      expect(openBrowserSpy).not.toHaveBeenCalled();

      // Error branch
      mockApp.start.mockRejectedValue(new Error('Port in use'));
      await expect(handleCliArgs(['inspect'], config, mockApp)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to start inspector:', 'Port in use');
    });

    it('handles start, stop, restart commands with app and error cases', async () => {
      const mockApp = {
        start: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 5000, pid: 111, reused: false }),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 5000, pid: 112 })
      };

      // Start new
      const resStart = await handleCliArgs(['start'], config, mockApp);
      expect(resStart.isCliCommand).toBe(true);
      expect(mockApp.start).toHaveBeenCalledWith({ background: true });

      // Start reused
      mockApp.start.mockResolvedValueOnce({ host: '127.0.0.1', port: 5000, pid: 111, reused: true });
      await handleCliArgs(['start', '--no-background'], config, mockApp);
      expect(mockApp.start).toHaveBeenCalledWith({ background: false });

      // Start error
      mockApp.start.mockRejectedValueOnce(new Error('Spawn error'));
      await expect(handleCliArgs(['start'], config, mockApp)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to start "test-server":', 'Spawn error');

      // Stop success & error
      await handleCliArgs(['stop'], config, mockApp);
      expect(mockApp.stop).toHaveBeenCalled();

      mockApp.stop.mockRejectedValueOnce(new Error('Kill error'));
      await expect(handleCliArgs(['stop'], config, mockApp)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to stop "test-server":', 'Kill error');

      // Restart success & error
      await handleCliArgs(['restart'], config, mockApp);
      expect(mockApp.restart).toHaveBeenCalled();

      mockApp.restart.mockRejectedValueOnce(new Error('Restart error'));
      await expect(handleCliArgs(['restart'], config, mockApp)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to restart "test-server":', 'Restart error');
    });

    it('returns standard options when no subcommand given', async () => {
      const res = await handleCliArgs(['--background', '--dev', '--no-singleton'], config);
      expect(res).toEqual({
        isCliCommand: false,
        background: true,
        devMode: true,
        noSingleton: true
      });

      const resShort = await handleCliArgs(['-b'], config);
      expect(resShort.background).toBe(true);
      expect(resShort.isCliCommand).toBe(false);
    });
  });
});
