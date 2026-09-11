import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/runtime/config.js';

describe('Runtime Config Resolution (src/runtime/config.ts)', () => {
  it('resolves defaults from app name string', () => {
    const config = resolveConfig('default-app', {});
    expect(config.name).toBe('default-app');
    expect(config.version).toBe('1.0.0');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(0);
    expect(config.logLevel).toBe('info');
    expect(config.retentionDays).toBe(7);
    expect(config.logToStderr).toBe(false);
    expect(config.registerInCentral).toBe(true);
    expect(config.background).toBe(false);
    expect(config.toolTimeoutMs).toBe(60000);
    expect(config.sequential).toBe(false);
    expect(config.maxConcurrency).toBeUndefined();
    expect(config.coerceInputs).toBe(false);
    expect(config.apiKey).toBeUndefined();
  });

  it('respects explicit configuration properties', () => {
    const config = resolveConfig({
      name: 'explicit-app',
      version: '2.5.0',
      host: '0.0.0.0',
      port: 8088,
      entrypoint: '/bin/server.js',
      toolTimeoutMs: 15000,
      sequential: true,
      coerceInputs: true,
      registerInCentral: false,
      background: true,
      logging: {
        level: 'debug',
        retentionDays: 30,
        logToStderr: true
      },
      apiKey: ['key1', 'key2'],
      rateLimit: { windowMs: 1000, maxRequests: 50 },
      cors: { origin: '*' }
    }, {});

    expect(config.version).toBe('2.5.0');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8088);
    expect(config.entrypoint).toBe('/bin/server.js');
    expect(config.toolTimeoutMs).toBe(15000);
    expect(config.sequential).toBe(true);
    expect(config.maxConcurrency).toBe(1);
    expect(config.coerceInputs).toBe(true);
    expect(config.registerInCentral).toBe(false);
    expect(config.background).toBe(true);
    expect(config.logLevel).toBe('debug');
    expect(config.retentionDays).toBe(30);
    expect(config.logToStderr).toBe(true);
    expect(config.apiKey).toEqual(['key1', 'key2']);
    expect(config.rateLimit?.maxRequests).toBe(50);
    expect(config.cors?.origin).toBe('*');
  });

  it('normalizes port and timeouts when invalid or negative values are given', () => {
    const config = resolveConfig({
      name: 'invalid-port-app',
      port: -5,
      toolTimeoutMs: -100
    }, {});

    expect(config.port).toBe(0);
    expect(config.toolTimeoutMs).toBe(60000);

    const fromEnv = resolveConfig('env-app', {
      MCP_SERVER_PORT: 'invalid-port',
      MCP_TOOL_TIMEOUT_MS: 'invalid-timeout'
    });
    expect(fromEnv.port).toBe(0);
    expect(fromEnv.toolTimeoutMs).toBe(60000);
  });

  it('reads environment variables for host, port, logging, and registry', () => {
    const config = resolveConfig('env-driven-app', {
      MCP_SERVER_HOST: '192.168.1.5',
      MCP_SERVER_PORT: '5555',
      MCP_SERVER_LOG_LEVEL: 'warn',
      MCP_DISABLE_REGISTRY: '1',
      MCP_BACKGROUND: '1',
      MCP_TOOL_TIMEOUT_MS: '25000',
      MCP_SEQUENTIAL: '1',
      MCP_COERCE_INPUTS: '1'
    });

    expect(config.host).toBe('192.168.1.5');
    expect(config.port).toBe(5555);
    expect(config.logLevel).toBe('warn');
    expect(config.registerInCentral).toBe(false);
    expect(config.background).toBe(true);
    expect(config.toolTimeoutMs).toBe(25000);
    expect(config.sequential).toBe(true);
    expect(config.maxConcurrency).toBe(1);
    expect(config.coerceInputs).toBe(true);
  });

  it('handles MCP_DISABLE_CENTRAL and MCPONCE_BACKGROUND env flags', () => {
    const config = resolveConfig('alt-env-app', {
      MCP_DISABLE_CENTRAL: '1',
      MCPONCE_BACKGROUND: '1',
      MCP_COERCE_INPUTS: 'true'
    });

    expect(config.registerInCentral).toBe(false);
    expect(config.background).toBe(true);
    expect(config.coerceInputs).toBe(true);
  });

  it('handles maxConcurrency configurations and single string apiKey', () => {
    const c1 = resolveConfig({
      name: 'concurrency-app',
      maxConcurrency: 10,
      apiKey: 'single-secret-key'
    }, {});

    expect(c1.maxConcurrency).toBe(10);
    expect(c1.sequential).toBe(false);
    expect(c1.apiKey).toEqual(['single-secret-key']);

    // maxConcurrency: 1 implies sequential
    const c2 = resolveConfig({
      name: 'single-conc-app',
      maxConcurrency: 1
    }, {});
    expect(c2.sequential).toBe(true);
  });

  it('resolves API keys from auth.apiKey and environment variables', () => {
    // 1. auth.apiKey
    const c1 = resolveConfig({
      name: 'auth-app',
      auth: { apiKey: 'auth-secret' }
    }, {});
    expect(c1.apiKey).toEqual(['auth-secret']);

    // 2. Comma separated MCPONCE_API_KEY
    const c2 = resolveConfig('env-keys-app', {
      MCPONCE_API_KEY: 'key_a,  key_b , key_c'
    });
    expect(c2.apiKey).toEqual(['key_a', 'key_b', 'key_c']);

    // 3. MCP_API_KEY and MCP_TOKEN
    const c3 = resolveConfig('token-app', {
      MCP_TOKEN: 'single-token'
    });
    expect(c3.apiKey).toEqual(['single-token']);

    // 4. Empty / whitespace token results in undefined
    const c4 = resolveConfig('empty-token-app', {
      MCP_TOKEN: ' , , '
    });
    expect(c4.apiKey).toBeUndefined();
  });

  it('preserves custom auth.validate validator and auth.excludedPaths', () => {
    const customValidator = async (token: string) => {
      return token === 'secret-admin' ? { user: 'admin', scopes: ['admin:all'] } : null;
    };

    const config = resolveConfig({
      name: 'custom-auth-app',
      auth: {
        validate: customValidator,
        excludedPaths: ['/health', '/metrics', '/public']
      }
    }, {});

    expect(config.auth?.validate).toBe(customValidator);
    expect(config.auth?.excludedPaths).toEqual(['/health', '/metrics', '/public']);
  });

  it('correctly passes through rateLimit and cors configuration objects', () => {
    const config = resolveConfig({
      name: 'network-options-app',
      rateLimit: {
        windowMs: 15000,
        maxRequests: 250
      },
      cors: {
        origin: ['https://app.example.com'],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: 86400
      }
    }, {});

    expect(config.rateLimit).toEqual({ windowMs: 15000, maxRequests: 250 });
    expect(config.cors?.origin).toEqual(['https://app.example.com']);
    expect(config.cors?.allowMethods).toContain('POST');
    expect(config.cors?.maxAge).toBe(86400);
  });

  it('falls back to default info log level for invalid or empty log levels', () => {
    const fromConfig = resolveConfig({
      name: 'bad-log-level-app',
      logging: { level: 'ultra-verbose' as any }
    }, {});
    expect(fromConfig.logLevel).toBe('ultra-verbose'); // direct config property is passed through

    const fromEnv = resolveConfig('env-bad-log-app', {
      MCP_SERVER_LOG_LEVEL: 'not-a-valid-level'
    });
    expect(fromEnv.logLevel).toBe('info');

    const fromEmptyEnv = resolveConfig('env-empty-log-app', {
      MCP_SERVER_LOG_LEVEL: ''
    });
    expect(fromEmptyEnv.logLevel).toBe('info');
  });

  it('handles negative, zero, and boundary retentionDays correctly', () => {
    const negativeRetention = resolveConfig({
      name: 'neg-retention-app',
      logging: { retentionDays: -10 }
    }, {});
    expect(negativeRetention.retentionDays).toBe(7); // negative falls back to default 7

    const zeroRetention = resolveConfig({
      name: 'zero-retention-app',
      logging: { retentionDays: 0 }
    }, {});
    expect(zeroRetention.retentionDays).toBe(0); // 0 is a valid retention window
  });

  it('handles toolTimeoutMs edge cases (0, NaN, negative, string env)', () => {
    const zeroTimeout = resolveConfig({
      name: 'zero-timeout-app',
      toolTimeoutMs: 0
    }, {});
    expect(zeroTimeout.toolTimeoutMs).toBe(0);

    const negTimeout = resolveConfig({
      name: 'neg-timeout-app',
      toolTimeoutMs: -500
    }, {});
    expect(negTimeout.toolTimeoutMs).toBe(60000);

    const envZero = resolveConfig('env-zero-timeout', {
      MCP_TOOL_TIMEOUT_MS: '0'
    });
    expect(envZero.toolTimeoutMs).toBe(0);

    const envNeg = resolveConfig('env-neg-timeout', {
      MCP_TOOL_TIMEOUT_MS: '-99'
    });
    expect(envNeg.toolTimeoutMs).toBe(60000);
  });

  it('evaluates MCP_COERCE_INPUTS environment variable combinations', () => {
    expect(resolveConfig('coerce-app-1', { MCP_COERCE_INPUTS: '1' }).coerceInputs).toBe(true);
    expect(resolveConfig('coerce-app-2', { MCP_COERCE_INPUTS: 'true' }).coerceInputs).toBe(true);
    expect(resolveConfig('coerce-app-3', { MCP_COERCE_INPUTS: '0' }).coerceInputs).toBe(false);
    expect(resolveConfig('coerce-app-4', { MCP_COERCE_INPUTS: 'false' }).coerceInputs).toBe(false);
    expect(resolveConfig('coerce-app-5', { MCP_COERCE_INPUTS: 'random' }).coerceInputs).toBe(false);
    expect(resolveConfig('coerce-app-6', {}).coerceInputs).toBe(false);
  });

  it('resolves sequential and maxConcurrency interaction matrix', () => {
    // maxConcurrency: 1 implies sequential
    const c1 = resolveConfig({ name: 'c-app-1', maxConcurrency: 1 }, {});
    expect(c1.sequential).toBe(true);
    expect(c1.maxConcurrency).toBe(1);

    // sequential: true without maxConcurrency defaults maxConcurrency to 1
    const c2 = resolveConfig({ name: 'c-app-2', sequential: true }, {});
    expect(c2.sequential).toBe(true);
    expect(c2.maxConcurrency).toBe(1);

    // sequential: true with explicit maxConcurrency keeps both
    const c3 = resolveConfig({ name: 'c-app-3', sequential: true, maxConcurrency: 4 }, {});
    expect(c3.sequential).toBe(true);
    expect(c3.maxConcurrency).toBe(4);

    // sequential: false with maxConcurrency > 1
    const c4 = resolveConfig({ name: 'c-app-4', sequential: false, maxConcurrency: 5 }, {});
    expect(c4.sequential).toBe(false);
    expect(c4.maxConcurrency).toBe(5);
  });

  it('preserves rawConfig referencing the original input config', () => {
    const rawInput = {
      name: 'raw-config-app',
      version: '3.0.0',
      entrypoint: '/custom/path.js'
    };
    const config = resolveConfig(rawInput, {});
    expect(config.rawConfig).toBe(rawInput);
    expect(config.entrypoint).toBe('/custom/path.js');
  });
});
