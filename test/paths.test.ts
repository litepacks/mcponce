import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { getDefaultDataDir, resolveDataDir, resolveLogDir } from '../src/runtime/paths.js';

describe('cross-platform paths', () => {
  const home = os.homedir();

  it('generates macOS Application Support path for darwin', () => {
    const dir = getDefaultDataDir('my-app', 'darwin', {});
    expect(dir).toBe(path.join(home, 'Library', 'Application Support', 'my-app'));
  });

  it('generates Linux path with XDG_STATE_HOME if set', () => {
    const dir = getDefaultDataDir('my-app', 'linux', {
      XDG_STATE_HOME: '/custom/xdg/state'
    });
    expect(dir).toBe(path.join('/custom/xdg/state', 'my-app'));
  });

  it('generates Linux fallback path when XDG_STATE_HOME is not set', () => {
    const dir = getDefaultDataDir('my-app', 'linux', {});
    expect(dir).toBe(path.join(home, '.local', 'state', 'my-app'));
  });

  it('generates Windows path using LOCALAPPDATA', () => {
    const dir = getDefaultDataDir('my-app', 'win32', {
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local'
    });
    expect(dir).toBe(path.join('C:\\Users\\Test\\AppData\\Local', 'my-app'));
  });

  it('generates Windows path using APPDATA fallback', () => {
    const dir = getDefaultDataDir('my-app', 'win32', {
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming'
    });
    expect(dir).toBe(path.join('C:\\Users\\Test\\AppData\\Roaming', '..', 'Local', 'my-app'));
  });

  it('generates Windows path using homedir fallback', () => {
    const dir = getDefaultDataDir('my-app', 'win32', {});
    expect(dir).toBe(path.join(home, 'AppData', 'Local', 'my-app'));
  });

  it('respects explicit dataDir override', () => {
    const explicit = '/tmp/my-custom-data-dir';
    const dir = resolveDataDir('my-app', explicit);
    expect(dir).toBe(path.resolve(explicit));
  });

  it('respects MCP_SERVER_DATA_DIR environment override', () => {
    const dir = resolveDataDir('my-app', undefined, 'darwin', {
      MCP_SERVER_DATA_DIR: '/env/data/dir'
    });
    expect(dir).toBe(path.resolve('/env/data/dir'));
  });

  it('falls back to default data dir when neither explicit nor env is passed', () => {
    const dir = resolveDataDir('my-app', undefined, 'darwin', {});
    expect(dir).toBe(getDefaultDataDir('my-app', 'darwin', {}));
  });

  it('resolves default logs directory under dataDir', () => {
    const logDir = resolveLogDir('/custom/data');
    expect(logDir).toBe(path.join('/custom/data', 'logs'));
  });

  it('respects explicit logDir and MCP_SERVER_LOG_DIR overrides', () => {
    const explicit = resolveLogDir('/data', '/custom/logs');
    expect(explicit).toBe(path.resolve('/custom/logs'));

    const fromEnv = resolveLogDir('/data', undefined, {
      MCP_SERVER_LOG_DIR: '/env/logs'
    });
    expect(fromEnv).toBe(path.resolve('/env/logs'));
  });
});
