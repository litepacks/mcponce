import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getClientConfigPath,
  resolveClientTargets,
  readClientConfig,
  writeClientConfig,
  installClientConfig,
  uninstallClientConfig
} from '../src/cli/installer.js';
import { handleCliArgs } from '../src/cli/index.js';

describe('MCP Client Auto-Installer', () => {
  const tmpDir = path.join(os.tmpdir(), `mcponce-installer-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('getClientConfigPath', () => {
    it('returns a valid path string for claude', () => {
      const p = getClientConfigPath('claude');
      expect(p).toContain('claude_desktop_config.json');
    });

    it('returns a valid path string for cursor (global)', () => {
      const p = getClientConfigPath('cursor');
      expect(p).toContain('mcp.json');
    });

    it('returns a project-level path string for cursor with project=true', () => {
      const p = getClientConfigPath('cursor', true);
      expect(p).toContain(path.join('.cursor', 'mcp.json'));
    });

    it('returns a path for antigravity', () => {
      const p = getClientConfigPath('antigravity');
      expect(p).toContain('mcp_config.json');
    });

    it('throws on unsupported client', () => {
      expect(() => getClientConfigPath('unknown_client')).toThrow(/Unsupported client/);
    });
  });

  describe('readClientConfig & writeClientConfig', () => {
    it('returns { mcpServers: {} } for non-existent files', () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist.json');
      const cfg = readClientConfig(nonExistent);
      expect(cfg).toEqual({ mcpServers: {} });
    });

    it('writes and reads back JSON config properly', () => {
      const target = path.join(tmpDir, 'subdir', 'mcp.json');
      const payload = {
        mcpServers: {
          testServer: {
            command: 'node',
            args: ['/path/to/server.js']
          }
        }
      };

      writeClientConfig(target, payload);
      expect(fs.existsSync(target)).toBe(true);

      const readBack = readClientConfig(target);
      expect(readBack).toEqual(payload);
    });
  });

  describe('installClientConfig', () => {
    it('installs server entry into specified custom path', () => {
      const customPath = path.join(tmpDir, 'claude_config.json');
      const results = installClientConfig({
        serverName: 'my-analytics-agent',
        entrypoint: '/Users/test/projects/agent/dist/index.js',
        customPath,
        background: true
      });

      expect(results).toHaveLength(1);
      expect(results[0].configPath).toBe(customPath);
      expect(results[0].updated).toBe(true);
      expect(results[0].serverEntry).toEqual({
        command: 'node',
        args: ['/Users/test/projects/agent/dist/index.js', '--background']
      });

      const config = readClientConfig(customPath);
      expect(config.mcpServers['my-analytics-agent']).toBeDefined();
      expect(config.mcpServers['my-analytics-agent'].args).toContain('--background');
    });

    it('detects .ts files and defaults to npx tsx runner', () => {
      const customPath = path.join(tmpDir, 'cursor_mcp.json');
      const results = installClientConfig({
        serverName: 'typescript-server',
        entrypoint: '/Users/test/projects/server.ts',
        customPath,
        background: true
      });

      expect(results[0].serverEntry.command).toBe('npx');
      expect(results[0].serverEntry.args).toEqual([
        'tsx',
        '/Users/test/projects/server.ts',
        '--background'
      ]);
    });

    it('supports custom environment variables', () => {
      const customPath = path.join(tmpDir, 'env_config.json');
      installClientConfig({
        serverName: 'secure-server',
        entrypoint: '/app/server.js',
        customPath,
        env: {
          API_KEY: 'secret_123',
          NODE_ENV: 'production'
        }
      });

      const config = readClientConfig(customPath);
      expect(config.mcpServers['secure-server'].env).toEqual({
        API_KEY: 'secret_123',
        NODE_ENV: 'production'
      });
    });

    it('preserves existing servers in configuration', () => {
      const customPath = path.join(tmpDir, 'multi_server.json');
      writeClientConfig(customPath, {
        mcpServers: {
          existingServer: {
            command: 'python',
            args: ['server.py']
          }
        }
      });

      installClientConfig({
        serverName: 'newServer',
        entrypoint: '/app/index.js',
        customPath
      });

      const config = readClientConfig(customPath);
      expect(config.mcpServers.existingServer).toBeDefined();
      expect(config.mcpServers.newServer).toBeDefined();
    });

    it('respects dryRun flag by not touching disk', () => {
      const customPath = path.join(tmpDir, 'dry_run_test.json');
      const results = installClientConfig({
        serverName: 'dry-server',
        entrypoint: '/app/dry.js',
        customPath,
        dryRun: true
      });

      expect(results[0].updated).toBe(true);
      expect(fs.existsSync(customPath)).toBe(false);
    });
  });

  describe('uninstallClientConfig', () => {
    it('removes server entry and leaves other servers intact', () => {
      const customPath = path.join(tmpDir, 'uninstall_test.json');
      writeClientConfig(customPath, {
        mcpServers: {
          keepMe: { command: 'node', args: ['keep.js'] },
          removeMe: { command: 'node', args: ['remove.js'] }
        }
      });

      const results = uninstallClientConfig({
        serverName: 'removeMe',
        customPath
      });

      expect(results[0].removed).toBe(true);

      const updated = readClientConfig(customPath);
      expect(updated.mcpServers.removeMe).toBeUndefined();
      expect(updated.mcpServers.keepMe).toBeDefined();
    });

    it('returns removed: false if server was not present', () => {
      const customPath = path.join(tmpDir, 'not_present.json');
      writeClientConfig(customPath, { mcpServers: {} });

      const results = uninstallClientConfig({
        serverName: 'ghostServer',
        customPath
      });

      expect(results[0].removed).toBe(false);
    });
  });

  describe('CLI handleCliArgs integration', () => {
    it('handles install command in dry-run mode', async () => {
      const dummyConfig = {
        name: 'cli-test-app',
        version: '1.0.0',
        entrypoint: '/path/to/script.js'
      } as any;

      const res = await handleCliArgs(['install', 'claude', '--dry-run'], dummyConfig);
      expect(res.isCliCommand).toBe(true);
    });

    it('handles uninstall command in dry-run mode', async () => {
      const dummyConfig = {
        name: 'cli-test-app',
        version: '1.0.0',
        entrypoint: '/path/to/script.js'
      } as any;

      const res = await handleCliArgs(['uninstall', 'claude', '--dry-run'], dummyConfig);
      expect(res.isCliCommand).toBe(true);
    });

    it('resolves win32 and linux paths for claude and cursor', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        expect(getClientConfigPath('claude')).toContain('Claude');
        expect(getClientConfigPath('cursor')).toContain('Cursor');

        Object.defineProperty(process, 'platform', { value: 'linux' });
        expect(getClientConfigPath('claude')).toContain('Claude');
        expect(getClientConfigPath('cursor')).toContain('Cursor');
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });

    it('readClientConfig handles empty, array, or malformed file', () => {
      const emptyFile = path.join(tmpDir, 'empty.json');
      fs.writeFileSync(emptyFile, '   ', 'utf-8');
      expect(readClientConfig(emptyFile)).toEqual({ mcpServers: {} });

      const primitiveFile = path.join(tmpDir, 'num.json');
      fs.writeFileSync(primitiveFile, '42', 'utf-8');
      expect(readClientConfig(primitiveFile)).toEqual({ mcpServers: {} });

      const malformedFile = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(malformedFile, 'not-json', 'utf-8');
      expect(() => readClientConfig(malformedFile)).toThrow('Failed to parse MCP configuration file');
    });
  });
});
