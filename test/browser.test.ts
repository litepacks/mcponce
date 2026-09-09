import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockExecHandler: ((cmd: string, cb: any) => void) | null = null;

vi.mock('node:child_process', () => ({
  exec: (cmd: string, cb: any) => {
    if (mockExecHandler) {
      return mockExecHandler(cmd, cb);
    }
    cb(null);
  }
}));

describe('openBrowser', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  let openBrowser: (url: string) => Promise<boolean>;

  beforeEach(async () => {
    mockExecHandler = null;
    delete process.env.CI;
    delete process.env.NO_BROWSER;
    const mod = await import('../src/utils/browser.js');
    openBrowser = mod.openBrowser;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns false immediately when process.env.CI is set', async () => {
    process.env.CI = 'true';
    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(false);
  });

  it('returns false immediately when process.env.NO_BROWSER is set', async () => {
    process.env.NO_BROWSER = '1';
    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(false);
  });

  it('uses "open" on darwin and resolves true on success', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    let executedCmd = '';
    mockExecHandler = (cmd, cb) => {
      executedCmd = cmd;
      cb(null);
    };

    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(true);
    expect(executedCmd).toBe('open "http://localhost:8080"');
  });

  it('uses "start" on win32 and resolves true on success', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let executedCmd = '';
    mockExecHandler = (cmd, cb) => {
      executedCmd = cmd;
      cb(null);
    };

    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(true);
    expect(executedCmd).toBe('start "" "http://localhost:8080"');
  });

  it('uses "xdg-open" on linux and other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    let executedCmd = '';
    mockExecHandler = (cmd, cb) => {
      executedCmd = cmd;
      cb(null);
    };

    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(true);
    expect(executedCmd).toBe('xdg-open "http://localhost:8080"');
  });

  it('resolves false when exec callback returns an error', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecHandler = (_cmd, cb) => {
      cb(new Error('Command failed'));
    };

    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(false);
  });

  it('resolves false when exec throws synchronously', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecHandler = () => {
      throw new Error('Sync throw');
    };

    const result = await openBrowser('http://localhost:8080');
    expect(result).toBe(false);
  });
});
