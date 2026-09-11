import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CentralRegistry } from '../src/registry/central.js';
import {
  setRegistry,
  formatStatus,
  pad,
  listServers,
  showStatus,
  stopServer,
  showLogs,
  cleanRegistry,
  callServerTool,
  listServerTools,
  installServer,
  uninstallServer,
  inspectServer,
  runOpenApiServer,
  printHelp,
  main,
  findLocalServerScript,
  extractServerNameFromEntrypoint,
  delegateToScript,
  parseMcpResponse
} from '../src/cli/bin.js';
import * as healthModule from '../src/runtime/health.js';
import * as browserModule from '../src/utils/browser.js';
import * as installerModule from '../src/cli/installer.js';

describe('mcponce CLI Binary Runner (src/cli/bin.ts)', () => {
  let tmpDir: string;
  let registryFile: string;
  let registry: CentralRegistry;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-bin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    registryFile = path.join(tmpDir, 'servers.json');

    registry = new CentralRegistry(registryFile);
    setRegistry(registry);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });

    vi.spyOn(healthModule, 'isPidRunning').mockImplementation((pid) => pid > 0);
    vi.spyOn(healthModule, 'checkHealth').mockImplementation(async (host, port, expectedName) => {
      return { ok: true, status: 'ok', name: expectedName } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pad & formatStatus & printHelp', () => {
    it('pads strings to desired width', () => {
      expect(pad('hello', 10)).toBe('hello     ');
      expect(pad('longerstring', 5)).toBe('longerstring');
    });

    it('formats running and stopped statuses with ANSI colors', () => {
      expect(formatStatus('running')).toContain('running');
      expect(formatStatus('stopped')).toContain('stopped');
    });

    it('prints help text', () => {
      printHelp();
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Central management CLI for local MCP servers');
      expect(logs).toContain('Commands:');
    });
  });

  describe('listServers', () => {
    it('prints empty message when registry has no servers', async () => {
      await listServers();
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No MCP servers registered yet.');
    });

    it('prints table of registered servers', async () => {
      await registry.register({
        name: 'test-app',
        version: '1.0.0',
        status: 'running',
        pid: 12345,
        port: 8080,
        host: '127.0.0.1',
        dataDir: '/data',
        logDir: '/logs'
      });
      await registry.register({
        name: 'stopped-app',
        version: '1.0.0',
        status: 'stopped',
        dataDir: '/data2',
        logDir: '/logs2'
      });

      await listServers();
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('test-app');
      expect(logs).toContain('stopped-app');
      expect(logs).toContain('12345');
    });
  });

  describe('showStatus', () => {
    it('calls listServers when no name is provided', async () => {
      await showStatus();
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No MCP servers registered yet.');
    });

    it('exits if server is not found in registry', async () => {
      await expect(showStatus('unknown-server')).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Server "unknown-server" not found in registry.');
    });

    it('prints stopped server status', async () => {
      await registry.register({
        name: 'stopped-server',
        version: '1.0.0',
        status: 'stopped',
        dataDir: '/data',
        logDir: '/logs'
      });

      await showStatus('stopped-server');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Name: stopped-server');
      expect(logs).toContain('Status: stopped');
    });

    it('prints running server status with health info', async () => {
      await registry.register({
        name: 'running-server',
        version: '2.0.0',
        status: 'running',
        pid: 5432,
        port: 9090,
        host: '127.0.0.1',
        dataDir: '/data',
        logDir: '/logs',
        startedAt: '2026-09-09T10:00:00.000Z'
      });

      vi.spyOn(healthModule, 'fetchInfo').mockResolvedValue({
        activeSessions: 3,
        totalSessions: 12,
        lastClientConnection: '2026-09-09T10:05:00.000Z',
        lastToolInvocation: {
          name: 'my-tool',
          timestamp: '2026-09-09T10:06:00.000Z'
        }
      } as any);

      await showStatus('running-server');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Name: running-server');
      expect(logs).toContain('Status: running');
      expect(logs).toContain('PID: 5432');
      expect(logs).toContain('Active sessions: 3');
      expect(logs).toContain('Total sessions: 12');
      expect(logs).toContain('Last connection: 2026-09-09T10:05:00.000Z');
      expect(logs).toContain('Last tool invocation: my-tool at 2026-09-09T10:06:00.000Z');
    });
  });

  describe('stopServer', () => {
    it('exits if no target specified', async () => {
      await expect(stopServer()).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Usage: mcponce stop <server-name | --all>');
    });

    it('handles --all when no servers are running', async () => {
      await stopServer('--all');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No running servers found.');
    });

    it('handles --all when servers are running', async () => {
      await registry.register({
        name: 'srv1',
        version: '1.0.0',
        status: 'running',
        pid: 1111,
        port: 8081,
        host: '127.0.0.1',
        dataDir: '/d1',
        logDir: '/l1'
      });

      vi.spyOn(registry, 'stop').mockResolvedValue(true);
      await stopServer('--all');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('done');
    });

    it('handles --all when stopping fails', async () => {
      await registry.register({
        name: 'srv2',
        version: '1.0.0',
        status: 'running',
        pid: 2222,
        port: 8082,
        host: '127.0.0.1',
        dataDir: '/d2',
        logDir: '/l2'
      });

      vi.spyOn(registry, 'stop').mockResolvedValue(false);
      await stopServer('--all');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('failed');
    });

    it('stops single server and reports success or failure', async () => {
      await expect(stopServer('not-found')).rejects.toThrow('process.exit(1)');

      await registry.register({
        name: 'srv3',
        version: '1.0.0',
        status: 'stopped',
        dataDir: '/d3',
        logDir: '/l3'
      });
      await stopServer('srv3');
      let logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Server "srv3" is already stopped.');

      await registry.register({
        name: 'srv4',
        version: '1.0.0',
        status: 'running',
        pid: 4444,
        port: 8084,
        host: '127.0.0.1',
        dataDir: '/d4',
        logDir: '/l4'
      });

      vi.spyOn(registry, 'stop').mockResolvedValueOnce(true);
      await stopServer('srv4');
      logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('done');

      vi.spyOn(registry, 'stop').mockResolvedValueOnce(false);
      await stopServer('srv4');
      logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('failed to stop');
    });
  });

  describe('showLogs & cleanRegistry', () => {
    it('showLogs exits if no server name provided', async () => {
      await expect(showLogs()).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Usage: mcponce logs <server-name> [lines]');
    });

    it('showLogs exits if server not registered', async () => {
      await expect(showLogs('unknown')).rejects.toThrow('process.exit(1)');
    });

    it('showLogs handles missing log file and existing log file with limit', async () => {
      const logDir = path.join(tmpDir, 'srv-logs');
      fs.mkdirSync(logDir, { recursive: true });

      await registry.register({
        name: 'srv-log-test',
        version: '1.0.0',
        status: 'stopped',
        dataDir: tmpDir,
        logDir
      });

      await showLogs('srv-log-test');
      let logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No logs found for this server.');

      const currentLog = path.join(logDir, 'current.log');
      fs.writeFileSync(currentLog, 'line 1\nline 2\nline 3\nline 4\n', 'utf-8');

      await showLogs('srv-log-test', '2');
      logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Recent 2 lines');
      expect(logs).toContain('line 3');
      expect(logs).toContain('line 4');
    });

    it('cleanRegistry removes stopped servers', async () => {
      vi.spyOn(registry, 'clean').mockResolvedValue(3);
      await cleanRegistry();
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Removed 3 stopped server(s) from registry.');
    });
  });

  describe('callServerTool', () => {
    it('exits if usage is incorrect or help requested', async () => {
      await expect(callServerTool()).rejects.toThrow('process.exit(1)');
      await expect(callServerTool('--help')).rejects.toThrow('process.exit(1)');
    });

    it('exits if server is not found or not running', async () => {
      await expect(callServerTool('not-found', 'ping')).rejects.toThrow('process.exit(1)');

      await registry.register({
        name: 'stopped-calc',
        version: '1.0.0',
        status: 'stopped',
        dataDir: tmpDir,
        logDir: tmpDir
      });
      await expect(callServerTool('stopped-calc', 'ping')).rejects.toThrow('process.exit(1)');
    });

    it('handles HTTP error from server', async () => {
      await registry.register({
        name: 'running-tool-server',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      } as any);

      await expect(callServerTool('running-tool-server', 'calc', [])).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('HTTP Error 500: Internal Server Error');
      globalThis.fetch = originalFetch;
    });

    it('handles JSON-RPC protocol error from server', async () => {
      await registry.register({
        name: 'running-tool-server',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          error: { code: -32601, message: 'Method not found' }
        })
      } as any);

      await expect(callServerTool('running-tool-server', 'unknownTool', [])).rejects.toThrow('process.exit(1)');
      const hadError = consoleErrorSpy.mock.calls.some((c: any) => String(c[0]).includes('Error [-32601]'));
      expect(hadError).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('handles tool execution failure isError in text and json mode', async () => {
      await registry.register({
        name: 'running-tool-server',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Computation error' }]
          }
        })
      } as any);

      // Text mode
      await expect(callServerTool('running-tool-server', 'badTool', [])).rejects.toThrow('process.exit(1)');
      const hadToolError = consoleErrorSpy.mock.calls.some((c: any) => String(c[0]).includes('Tool Error [badTool]'));
      expect(hadToolError).toBe(true);

      // JSON mode
      await expect(callServerTool('running-tool-server', 'badTool', ['--json'])).rejects.toThrow('process.exit(1)');
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Computation error');

      globalThis.fetch = originalFetch;
    });

    it('handles successful tool response in text and JSON mode with token', async () => {
      await registry.register({
        name: 'running-tool-server',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            content: [{ type: 'text', text: 'Result: 42' }]
          }
        })
      } as any);

      await callServerTool('running-tool-server', 'calc', ['--a', '10', '--token', 'secret123']);
      let logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Result: 42');

      // Test JSON mode
      consoleLogSpy.mockClear();
      await callServerTool('running-tool-server', 'calc', ['--json']);
      logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Result: 42');

      // Test fetch network rejection
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection failed'));
      await expect(callServerTool('running-tool-server', 'calc', [])).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to invoke tool on server "running-tool-server":'), 'Connection failed');

      globalThis.fetch = originalFetch;
    });
  });

  describe('listServerTools', () => {
    it('exits if usage is incorrect or help requested', async () => {
      await expect(listServerTools()).rejects.toThrow('process.exit(1)');
      await expect(listServerTools('--help')).rejects.toThrow('process.exit(1)');
    });

    it('exits if server is not found or not running', async () => {
      await expect(listServerTools('not-found')).rejects.toThrow('process.exit(1)');

      await registry.register({
        name: 'stopped-srv',
        version: '1.0.0',
        status: 'stopped',
        dataDir: tmpDir,
        logDir: tmpDir
      });
      await expect(listServerTools('stopped-srv')).rejects.toThrow('process.exit(1)');
    });

    it('handles HTTP error and JSON-RPC error', async () => {
      await registry.register({
        name: 'active-srv',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden'
      } as any);

      await expect(listServerTools('active-srv')).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('HTTP Error 403: Forbidden');

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: { message: 'Unauthorized' } })
      } as any);
      await expect(listServerTools('active-srv')).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Unauthorized');

      globalThis.fetch = originalFetch;
    });

    it('prints registered tools with schemas or empty message', async () => {
      await registry.register({
        name: 'active-srv',
        version: '1.0.0',
        status: 'running',
        pid: 1234,
        port: 8080,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const originalFetch = globalThis.fetch;
      // Empty tools
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { tools: [] } })
      } as any);

      await listServerTools('active-srv');
      let logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('No tools registered on this server.');

      // Non-empty tools (with and without inputSchema properties)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            tools: [
              {
                name: 'calculate',
                description: 'Math calculator',
                inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' } } }
              },
              {
                name: 'noop',
                description: 'No parameters tool',
                inputSchema: {}
              }
            ]
          }
        })
      } as any);

      consoleLogSpy.mockClear();
      await listServerTools('active-srv');
      logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Tools available on server "active-srv" (2):');
      expect(logs).toContain('calculate');
      expect(logs).toContain('Math calculator');
      expect(logs).toContain('--a <number>');
      expect(logs).toContain('noop');

      // Network throw
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS failure'));
      await expect(listServerTools('active-srv')).rejects.toThrow('process.exit(1)');

      globalThis.fetch = originalFetch;
    });
  });

  describe('installServer & uninstallServer', () => {
    it('installServer exits without target', async () => {
      await expect(installServer()).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcponce install'));
    });

    it('installServer configures file target or registered server', async () => {
      const dummyScript = path.join(tmpDir, 'my-server.js');
      fs.writeFileSync(dummyScript, '// server code', 'utf-8');

      const installSpy = vi.spyOn(installerModule, 'installClientConfig').mockReturnValue([
        {
          client: 'claude',
          configPath: '/cfg/claude.json',
          serverEntry: { command: 'node', args: ['my-server.js'] }
        }
      ]);

      await installServer(dummyScript, 'claude', ['--dry-run', '--project', '--no-background']);
      expect(installSpy).toHaveBeenCalledWith({
        serverName: 'my-server',
        entrypoint: path.resolve(dummyScript),
        client: 'claude',
        background: false,
        project: true,
        dryRun: true
      });

      // Target with index.js name derives from parent dir
      const indexScript = path.join(tmpDir, 'index.js');
      fs.writeFileSync(indexScript, '// code', 'utf-8');
      await installServer(indexScript, 'all', []);
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: path.basename(tmpDir),
          entrypoint: path.resolve(indexScript)
        })
      );

      // Target as registered server
      await registry.register({
        name: 'reg-app',
        version: '1.0.0',
        status: 'stopped',
        dataDir: tmpDir,
        logDir: tmpDir
      });
      await installServer('reg-app', 'cursor', []);
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'reg-app'
        })
      );

      // Error branch
      installSpy.mockImplementation(() => {
        throw new Error('Install error');
      });
      await expect(installServer(dummyScript)).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to install client config:', 'Install error');
    });

    it('uninstallServer exits without target or handles removed/not-found and errors', async () => {
      await expect(uninstallServer()).rejects.toThrow('process.exit(1)');

      const uninstallSpy = vi.spyOn(installerModule, 'uninstallClientConfig').mockReturnValue([
        { client: 'claude', configPath: '/cfg/c.json', removed: true },
        { client: 'cursor', configPath: '/cfg/u.json', removed: false }
      ]);

      await uninstallServer('my-app', 'all', ['--dry-run', '--project']);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Removed "my-app" from claude');
      expect(logs).toContain('"my-app" was not found in cursor');

      uninstallSpy.mockImplementation(() => {
        throw new Error('Uninstall error');
      });
      await expect(uninstallServer('my-app')).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to uninstall client config:', 'Uninstall error');
    });
  });

  describe('inspectServer & runOpenApiServer', () => {
    it('inspectServer exits if no servers running or specified server is stopped', async () => {
      await expect(inspectServer()).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('No running MCP servers found in central registry.');

      await registry.register({
        name: 'stopped-one',
        version: '1.0.0',
        status: 'stopped',
        dataDir: tmpDir,
        logDir: tmpDir
      });
      await expect(inspectServer('stopped-one')).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Server "stopped-one" is not running.');
    });

    it('inspectServer opens web inspector in browser for running server', async () => {
      await registry.register({
        name: 'running-inspect',
        version: '1.0.0',
        status: 'running',
        pid: 7777,
        port: 9091,
        host: '127.0.0.1',
        dataDir: tmpDir,
        logDir: tmpDir
      });

      const openBrowserSpy = vi.spyOn(browserModule, 'openBrowser').mockResolvedValue(true);
      await inspectServer();
      expect(openBrowserSpy).toHaveBeenCalledWith('http://127.0.0.1:9091/inspect');
    });

    it('runOpenApiServer exits without spec or runs app with openapi', async () => {
      await expect(runOpenApiServer('', [])).rejects.toThrow('process.exit(1)');

      const openBrowserSpy = vi.spyOn(browserModule, 'openBrowser').mockResolvedValue(true);
      const mockApp = {
        fromOpenApi: vi.fn().mockResolvedValue(5),
        start: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 3000 }),
        getInspectorUrl: vi.fn().mockReturnValue('http://127.0.0.1:3000/inspect')
      };

      vi.doMock('../src/index.js', () => ({
        createMcpServer: () => mockApp
      }));

      // With browser open
      await runOpenApiServer('https://petstore.swagger.io/v2/swagger.json', [
        '--port',
        '3001',
        '--prefix',
        'pet_',
        '--name',
        'petstore'
      ]);
      expect(mockApp.fromOpenApi).toHaveBeenCalledWith('https://petstore.swagger.io/v2/swagger.json', {
        prefix: 'pet_'
      });
      expect(openBrowserSpy).toHaveBeenCalledWith('http://127.0.0.1:3000/inspect');

      // With --no-inspect
      openBrowserSpy.mockClear();
      await runOpenApiServer('https://petstore.swagger.io/v2/swagger.json', ['--no-inspect']);
      expect(openBrowserSpy).not.toHaveBeenCalled();
    });
  });

  describe('main dispatcher', () => {
    it('dispatches list, ls, undefined commands', async () => {
      await main([]);
      await main(['list']);
      await main(['ls']);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('mcponce servers');
    });

    it('dispatches status command', async () => {
      await main(['status']);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('mcponce servers');
    });

    it('dispatches install & uninstall commands', async () => {
      const installSpy = vi.spyOn(installerModule, 'installClientConfig').mockReturnValue([]);
      const uninstallSpy = vi.spyOn(installerModule, 'uninstallClientConfig').mockReturnValue([]);

      const dummyFile = path.join(tmpDir, 'test.js');
      fs.writeFileSync(dummyFile, '//', 'utf-8');

      await main(['install', dummyFile, 'claude', '--dry-run']);
      expect(installSpy).toHaveBeenCalled();

      await main(['uninstall', 'dummy', 'cursor', '--dry-run']);
      expect(uninstallSpy).toHaveBeenCalled();
    });

    it('dispatches call, tools, stop, logs, inspect, openapi, clean', async () => {
      // call invalid -> exits
      await expect(main(['call'])).rejects.toThrow('process.exit(1)');

      // tools invalid -> exits
      await expect(main(['tools'])).rejects.toThrow('process.exit(1)');

      // stop invalid -> exits
      await expect(main(['stop'])).rejects.toThrow('process.exit(1)');

      // logs invalid -> exits
      await expect(main(['logs'])).rejects.toThrow('process.exit(1)');

      // inspect invalid -> exits
      await expect(main(['inspect'])).rejects.toThrow('process.exit(1)');

      // openapi invalid -> exits
      await expect(main(['openapi'])).rejects.toThrow('process.exit(1)');
      await expect(main(['from-openapi'])).rejects.toThrow('process.exit(1)');

      // clean
      await main(['clean']);
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Removed 0 stopped server(s) from registry.');
    });

    it('dispatches help and version commands', async () => {
      for (const cmd of ['help', '--help', '-h']) {
        await main([cmd]);
      }
      for (const cmd of ['version', '--version', '-v']) {
        await main([cmd]);
      }
      const logs = consoleLogSpy.mock.calls.map((c: any) => c[0]).join('\n');
      expect(logs).toContain('Central management CLI');
      expect(logs).toContain('mcponce v1.0.0');
    });

    it('exits with code 1 for unknown commands', async () => {
      await expect(main(['unknown-subcommand'])).rejects.toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Unknown command: unknown-subcommand\n');
    });
  });

  describe('Helper functions (findLocalServerScript, extractServerName, parseMcpResponse)', () => {
    it('findLocalServerScript returns candidate if found in current directory', () => {
      expect(findLocalServerScript(tmpDir)).toBeNull();

      fs.writeFileSync(path.join(tmpDir, 'server.js'), '// test');
      expect(findLocalServerScript(tmpDir)).toBe('server.js');

      fs.writeFileSync(path.join(tmpDir, 'index.js'), '// test');
      expect(findLocalServerScript(tmpDir)).toBe('index.js');
    });

    it('findLocalServerScript respects resolution priority across .ts, .mjs, and .js', () => {
      const specificDir = path.join(tmpDir, 'priority-test');
      fs.mkdirSync(specificDir, { recursive: true });

      fs.writeFileSync(path.join(specificDir, 'server.ts'), '// typescript');
      expect(findLocalServerScript(specificDir)).toBe('server.ts');

      fs.writeFileSync(path.join(specificDir, 'server.mjs'), '// esm');
      expect(findLocalServerScript(specificDir)).toBe('server.mjs');

      fs.writeFileSync(path.join(specificDir, 'app.js'), '// app');
      expect(findLocalServerScript(specificDir)).toBe('app.js');

      fs.writeFileSync(path.join(specificDir, 'server.js'), '// server');
      expect(findLocalServerScript(specificDir)).toBe('server.js');

      fs.writeFileSync(path.join(specificDir, 'index.js'), '// index');
      expect(findLocalServerScript(specificDir)).toBe('index.js');
    });

    it('extractServerNameFromEntrypoint detects name from file or package.json', () => {
      const scriptFile = path.join(tmpDir, 'dummy-server.js');
      fs.writeFileSync(scriptFile, `new McpServer({ name: 'custom-mcp-app' });`);
      expect(extractServerNameFromEntrypoint(scriptFile)).toBe('custom-mcp-app');

      const noNameFile = path.join(tmpDir, 'plain.js');
      fs.writeFileSync(noNameFile, `console.log("hello");`);
      expect(extractServerNameFromEntrypoint(noNameFile)).toBeNull();

      // With package.json in same dir
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'pkg-mcp-app' }));
      expect(extractServerNameFromEntrypoint(noNameFile)).toBe('pkg-mcp-app');
      expect(extractServerNameFromEntrypoint('/nonexistent/path/file.js')).toBeNull();
    });

    it('extractServerNameFromEntrypoint detects createMcpServer name patterns with double quotes or multi-line', () => {
      const esmFile = path.join(tmpDir, 'multi-line.js');
      fs.writeFileSync(
        esmFile,
        `import { createMcpServer } from 'mcponce';\n\nconst server = createMcpServer({\n  name: "double-quote-app",\n  version: "1.0.0"\n});`
      );
      expect(extractServerNameFromEntrypoint(esmFile)).toBe('double-quote-app');

      const shorthandFile = path.join(tmpDir, 'shorthand.js');
      fs.writeFileSync(shorthandFile, `const app = createMcpServer('shorthand-app');`);
      expect(extractServerNameFromEntrypoint(shorthandFile)).toBe('shorthand-app');
    });

    it('parseMcpResponse handles SSE stream, JSON response, and fallback text', async () => {
      // SSE text/event-stream with data: line
      const sseRes = {
        headers: { get: () => 'text/event-stream' },
        text: async () => 'event: message\ndata: {"jsonrpc":"2.0","result":{"text":"ok"}}\n\n'
      };
      expect(await parseMcpResponse(sseRes)).toEqual({ jsonrpc: '2.0', result: { text: 'ok' } });

      // Plain JSON
      const jsonRes = {
        headers: { get: () => 'application/json' },
        json: async () => ({ hello: 'world' })
      };
      expect(await parseMcpResponse(jsonRes)).toEqual({ hello: 'world' });

      // Fallback text with data:
      const fallbackRes = {
        headers: { get: () => 'text/plain' },
        json: async () => { throw new Error('Not JSON'); },
        text: async () => 'data: {"fallback":"ok"}'
      };
      expect(await parseMcpResponse(fallbackRes)).toEqual({ fallback: 'ok' });
    });

    it('parseMcpResponse handles raw non-SSE non-JSON text safely', async () => {
      const plainRes = {
        headers: { get: () => 'text/plain' },
        json: async () => { throw new Error('Not JSON'); },
        text: async () => 'Server error occurred'
      };
      expect(await parseMcpResponse(plainRes)).toEqual({ raw: 'Server error occurred' });
    });
  });
});
