import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpServer,
  RateLimiter,
  extractAuthToken,
  verifyToolScopes,
  parseParametricArgs
} from '../src/index.js';

describe('Security, Auth & Rate Limiting System', () => {
  describe('Unit: RateLimiter', () => {
    it('allows requests within rate limit and computes remaining count', () => {
      const limiter = new RateLimiter({ max: 3, windowMs: 1000 });

      const res1 = limiter.check('client-1');
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(2);
      expect(res1.resetMs).toBeGreaterThan(0);

      const res2 = limiter.check('client-1');
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(1);

      const res3 = limiter.check('client-1');
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(0);

      // Exceeded
      const res4 = limiter.check('client-1');
      expect(res4.allowed).toBe(false);
      expect(res4.remaining).toBe(0);

      // Different client is unaffected
      const resOther = limiter.check('client-2');
      expect(resOther.allowed).toBe(true);
      expect(resOther.remaining).toBe(2);

      limiter.destroy();
    });

    it('resets windows upon expiration or manual reset', async () => {
      const limiter = new RateLimiter({ max: 2, windowMs: 50 });

      limiter.check('ip-1');
      limiter.check('ip-1');
      expect(limiter.check('ip-1').allowed).toBe(false);

      // Manual reset
      limiter.reset();
      expect(limiter.check('ip-1').allowed).toBe(true);

      // Wait for window expiration
      limiter.check('ip-1');
      expect(limiter.check('ip-1').allowed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(limiter.check('ip-1').allowed).toBe(true);

      limiter.destroy();
    });
  });

  describe('Unit: extractAuthToken', () => {
    it('extracts Bearer token from authorization header', () => {
      expect(extractAuthToken({ authorization: 'Bearer secret-123' })).toBe('secret-123');
      expect(extractAuthToken({ Authorization: 'bearer   token-abc  ' })).toBe('token-abc');
      expect(extractAuthToken({ authorization: 'raw-token-value' })).toBe('raw-token-value');
    });

    it('extracts API key from x-api-key header', () => {
      expect(extractAuthToken({ 'x-api-key': 'key-xyz' })).toBe('key-xyz');
      expect(extractAuthToken({ 'X-API-Key': 'key-XYZ-upper' })).toBe('key-XYZ-upper');
    });

    it('extracts token from query parameter fallback', () => {
      expect(extractAuthToken({}, 'query-token-777')).toBe('query-token-777');
    });

    it('returns undefined when no token or key is provided', () => {
      expect(extractAuthToken({})).toBeUndefined();
      expect(extractAuthToken({}, '')).toBeUndefined();
    });
  });

  describe('Unit: verifyToolScopes', () => {
    it('returns true when tool requires no scopes', () => {
      expect(verifyToolScopes([], ['read'])).toBe(true);
      expect(verifyToolScopes(undefined, ['read'])).toBe(true);
    });

    it('returns false when identity has no scopes but tool requires scopes', () => {
      expect(verifyToolScopes(['admin:write'], [])).toBe(false);
      expect(verifyToolScopes(['admin:write'], undefined)).toBe(false);
    });

    it('allows wildcards * and admin for any requirement', () => {
      expect(verifyToolScopes(['sensitive:read', 'user:delete'], ['*'])).toBe(true);
      expect(verifyToolScopes(['sensitive:read'], ['admin'])).toBe(true);
    });

    it('matches exact and namespace prefix scopes', () => {
      expect(verifyToolScopes(['tools:read'], ['tools:read', 'tools:write'])).toBe(true);
      expect(verifyToolScopes(['db:users:read'], ['db:*'])).toBe(true);
      expect(verifyToolScopes(['db:users:read', 'db:users:write'], ['db:*'])).toBe(true);
      expect(verifyToolScopes(['billing:charge'], ['db:*'])).toBe(false);
    });
  });

  describe('Tool-level requireAuth and Scopes Enforcement', () => {
    it('enforces requireAuth on individual tools and passes auth to context/extra', async () => {
      const app = createMcpServer({
        name: 'scoped-tool-server'
      });

      let capturedExtraAuth: any;
      let capturedContextAuth: any;

      app.tool({
        name: 'protected_tool',
        description: 'Only authenticated users can execute this',
        inputSchema: { query: z.string() },
        requireAuth: true,
        handler: async (args, ctx, extra) => {
          capturedContextAuth = (ctx as any).auth;
          capturedExtraAuth = extra.auth;
          return `Protected data for ${args.query}`;
        }
      });

      // 1. Invocation without auth fails
      await expect(
        app.callTool('protected_tool', { query: 'test' })
      ).rejects.toThrow(/Authentication required for tool "protected_tool"/);

      // 2. Invocation with auth succeeds and propagates identity
      const result = await app.callTool(
        'protected_tool',
        { query: 'test' },
        { auth: { id: 'usr-1', user: 'alice', scopes: ['user'] } }
      );

      expect(result.text).toBe('Protected data for test');
      expect(capturedContextAuth).toEqual({ id: 'usr-1', user: 'alice', scopes: ['user'] });
      expect(capturedExtraAuth).toEqual({ id: 'usr-1', user: 'alice', scopes: ['user'] });
    });

    it('enforces permission scopes on tools', async () => {
      const app = createMcpServer({
        name: 'rbac-server'
      });

      app.tool({
        name: 'delete_database',
        description: 'Dangerous admin operation',
        inputSchema: {},
        scopes: ['admin:databases', 'write'],
        handler: async () => 'Database dropped'
      });

      // Missing scopes
      await expect(
        app.callTool('delete_database', {}, { auth: { user: 'bob', scopes: ['read'] } })
      ).rejects.toThrow(/Forbidden: Tool "delete_database" requires scopes/);

      // Partial scopes
      await expect(
        app.callTool('delete_database', {}, { auth: { user: 'bob', scopes: ['admin:databases'] } })
      ).rejects.toThrow(/Forbidden: Tool "delete_database" requires scopes/);

      // Matching scopes
      const result1 = await app.callTool(
        'delete_database',
        {},
        { auth: { user: 'admin_user', scopes: ['admin:databases', 'write'] } }
      );
      expect(result1.text).toBe('Database dropped');

      // Wildcard scope
      const result2 = await app.callTool(
        'delete_database',
        {},
        { auth: { user: 'superadmin', scopes: ['*'] } }
      );
      expect(result2.text).toBe('Database dropped');
    });

    it('propagates auth identity to sub-tool invocations', async () => {
      const app = createMcpServer({
        name: 'composite-auth-server'
      });

      let subToolCalledWithAuth: any;

      app.tool({
        name: 'sub_tool',
        description: 'Internal protected tool',
        inputSchema: {},
        requireAuth: true,
        handler: async (args, ctx, extra) => {
          subToolCalledWithAuth = extra.auth;
          return 'sub-success';
        }
      });

      app.tool({
        name: 'parent_tool',
        description: 'Calls sub_tool',
        inputSchema: {},
        handler: async (args, ctx, extra) => {
          const sub = await extra.callTool('sub_tool', {});
          return `parent -> ${sub.text}`;
        }
      });

      const res = await app.callTool(
        'parent_tool',
        {},
        { auth: { id: 'token-999', role: 'service' } }
      );

      expect(res.text).toBe('parent -> sub-success');
      expect(subToolCalledWithAuth).toEqual({ id: 'token-999', role: 'service' });
    });
  });

  describe('Integration: HTTP Security Headers, CORS, Rate Limiting & Auth Validator', () => {
    it('sets enterprise security headers on all responses', async () => {
      const app = createMcpServer({
        name: 'secure-headers-server',
        port: 0
      });

      const startRes = await app.start();
      const baseUrl = `http://127.0.0.1:${startRes.port}`;

      try {
        const res = await fetch(`${baseUrl}/health`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        expect(res.headers.get('x-xss-protection')).toBe('1; mode=block');
      } finally {
        await app.stop();
      }
    });

    it('supports customizable CORS origin and headers', async () => {
      const app = createMcpServer({
        name: 'cors-server',
        port: 0,
        cors: {
          origin: 'https://app.example.com',
          credentials: true,
          allowHeaders: ['Content-Type', 'Authorization', 'X-Custom-Header']
        }
      });

      const startRes = await app.start();
      const baseUrl = `http://127.0.0.1:${startRes.port}`;

      try {
        const res = await fetch(`${baseUrl}/health`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.example.com',
            'Access-Control-Request-Method': 'POST'
          }
        });

        expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        await app.stop();
      }
    });

    it('enforces rate limiting and returns 429 Too Many Requests with Retry-After', async () => {
      const app = createMcpServer({
        name: 'rate-limited-server',
        port: 0,
        rateLimit: {
          max: 3,
          windowMs: 2000
        }
      });

      const startRes = await app.start();
      const baseUrl = `http://127.0.0.1:${startRes.port}`;

      try {
        // First 3 requests to /info succeed
        for (let i = 0; i < 3; i++) {
          const res = await fetch(`${baseUrl}/info`);
          expect(res.status).toBe(200);
          expect(res.headers.get('x-ratelimit-limit')).toBe('3');
          expect(Number(res.headers.get('x-ratelimit-remaining'))).toBe(2 - i);
        }

        // 4th request exceeds limit
        const rateLimitedRes = await fetch(`${baseUrl}/info`);
        expect(rateLimitedRes.status).toBe(429);
        expect(rateLimitedRes.headers.get('retry-after')).toBeDefined();

        const json = (await rateLimitedRes.json()) as any;
        expect(json.error.message).toContain('Rate limit exceeded');

        // /health endpoint is excluded from rate limiting
        const healthRes = await fetch(`${baseUrl}/health`);
        expect(healthRes.status).toBe(200);
      } finally {
        await app.stop();
      }
    });

    it('supports custom auth.validate validator with scopes and role propagation', async () => {
      const validatorMock = vi.fn(async (token?: string, ctx?: any) => {
        if (token === 'admin-jwt-token') {
          return {
            id: 'admin-1',
            user: 'superadmin',
            role: 'admin',
            scopes: ['admin:*']
          };
        }
        if (token === 'readonly-jwt-token') {
          return {
            id: 'viewer-1',
            user: 'viewer',
            role: 'viewer',
            scopes: ['read']
          };
        }
        return false;
      });

      const app = createMcpServer({
        name: 'custom-auth-server',
        port: 0,
        auth: {
          validate: validatorMock,
          excludedPaths: ['/info']
        }
      });

      const startRes = await app.start();
      const baseUrl = `http://127.0.0.1:${startRes.port}`;

      try {
        // 1. Health is excluded by default
        const healthRes = await fetch(`${baseUrl}/health`);
        expect(healthRes.status).toBe(200);

        // 2. Info was explicitly excluded in excludedPaths
        const infoRes = await fetch(`${baseUrl}/info`);
        expect(infoRes.status).toBe(200);

        // 3. /analytics is protected: unauthorized without token
        const unauthRes = await fetch(`${baseUrl}/analytics`);
        expect(unauthRes.status).toBe(401);

        // 4. /analytics with invalid token
        const invalidRes = await fetch(`${baseUrl}/analytics`, {
          headers: { Authorization: 'Bearer bad-token' }
        });
        expect(invalidRes.status).toBe(401);

        // 5. /analytics with valid admin token
        const validRes = await fetch(`${baseUrl}/analytics`, {
          headers: { Authorization: 'Bearer admin-jwt-token' }
        });
        expect(validRes.status).toBe(200);

        expect(validatorMock).toHaveBeenCalled();
      } finally {
        await app.stop();
      }
    });
  });

  describe('CLI Parameter Parsing for Auth', () => {
    it('parses --token and --api-key arguments cleanly', () => {
      const res1 = parseParametricArgs(['--token', 'my-auth-secret', '--name', 'test']);
      expect(res1.token).toBe('my-auth-secret');
      expect(res1.params).toEqual({ name: 'test' });

      const res2 = parseParametricArgs(['--api-key=secret-key-123', '--count', '5']);
      expect(res2.token).toBe('secret-key-123');
      expect(res2.params).toEqual({ count: 5 });
    });
  });
});
