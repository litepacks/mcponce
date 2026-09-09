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
});
