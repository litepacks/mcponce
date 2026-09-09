import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHonoApp } from '../src/server/hono.js';
import { normalizeToolResult } from '../src/server/mcp.js';
import { createMcpServer, McpApp } from '../src/index.js';
import { ToolRegistry } from '../src/registry/tools.js';
import { ResourceRegistry } from '../src/registry/resources.js';
import { PromptRegistry } from '../src/registry/prompts.js';
import { ContextManager } from '../src/server/context.js';
import { AnalyticsCollector } from '../src/server/analytics.js';
import { SubscriptionRegistry } from '../src/registry/subscriptions.js';
import { resolveConfig } from '../src/runtime/config.js';
import { z } from 'zod';

describe('Server Coverage: Hono, MCP Server, and McpApp Edge Cases', () => {
  let app: McpApp<any> | null = null;

  afterEach(async () => {
    if (app) {
      await app.stop({ background: false });
      app = null;
    }
  });

  describe('mcp.ts normalizeToolResult & Tool Execution Authorization', () => {
    it('normalizeToolResult handles null, undefined, and direct ImageContent objects', () => {
      // null / undefined (lines 39-44)
      const resNull = normalizeToolResult(null);
      expect(resNull).toEqual({ content: [], data: null, text: '' });

      const resUndef = normalizeToolResult(undefined);
      expect(resUndef).toEqual({ content: [], data: undefined, text: '' });

      // direct image content (lines 57-62)
      const resImg = normalizeToolResult({
        type: 'image',
        data: 'aGVsbG8=',
        mimeType: 'image/png'
      });
      expect(resImg.text).toBe('[Image: image/png]');
      expect(resImg.content[0].type).toBe('image');
    });

    it('requires auth and verifies scopes on tool execution', async () => {
      const server = createMcpServer({
        name: 'auth-scope-server',
        port: 0,
        dataDir: `./.mcponce-test-auth-${Date.now()}`
      });
      app = server;

      server.tool({
        name: 'secured_tool',
        requireAuth: true,
        handler: async () => 'secret'
      });

      server.tool({
        name: 'scoped_tool',
        scopes: ['admin:write'],
        handler: async () => 'scoped_secret'
      });

      const startRes = await server.start();
      const host = startRes.host;
      const port = startRes.port;

      // 1. Call secured_tool without auth -> error
      await expect(server.callTool('secured_tool', {})).rejects.toThrow();

      // 2. Call scoped_tool without required scopes -> error
      await expect(
        server.callTool('scoped_tool', {}, { auth: { role: 'user', scopes: ['read:only'] } })
      ).rejects.toThrow('Forbidden: Tool "scoped_tool" requires scopes: admin:write');

      // 3. Call scoped_tool with valid scopes -> success
      const successRes = await server.callTool(
        'scoped_tool',
        {},
        { auth: { role: 'admin', scopes: ['admin:write'] } }
      );
      expect(successRes.data).toBe('scoped_secret');
    });
  });

  describe('hono.ts CORS function, GET/DELETE /mcp, and system://metrics resource', () => {
    it('CORS origin function returning boolean and string', async () => {
      let originCheckResult: boolean | string = true;
      const config = resolveConfig({
        name: 'cors-test',
        cors: {
          origin: (origin: string) => originCheckResult
        }
      });

      const toolRegistry = new ToolRegistry();
      const resourceRegistry = new ResourceRegistry();
      const promptRegistry = new PromptRegistry();
      const contextManager = new ContextManager();
      const metrics = { startedAt: new Date().toISOString(), activeSessions: 0, totalSessions: 0 };
      const analytics = new AnalyticsCollector();

      const hono = createHonoApp({
        config,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        metrics,
        analytics,
        portProvider: () => 3000
      });

      // Test origin function returning boolean true (lines 105-107)
      const resTrue = await hono.request('/health', {
        headers: { Origin: 'http://allowed.com' }
      });
      expect(resTrue.headers.get('Access-Control-Allow-Origin')).toBe('http://allowed.com');

      // Test origin function returning boolean false (null)
      originCheckResult = false;
      const resFalse = await hono.request('/health', {
        headers: { Origin: 'http://disallowed.com' }
      });
      expect(resFalse.headers.get('Access-Control-Allow-Origin')).toBeNull();

      // Test origin function returning custom string
      originCheckResult = 'http://custom-origin.org';
      const resCustom = await hono.request('/health', {
        headers: { Origin: 'http://some-origin.com' }
      });
      expect(resCustom.headers.get('Access-Control-Allow-Origin')).toBe('http://custom-origin.org');
    });

    it('GET /mcp and DELETE /mcp error handling with missing/invalid sessions', async () => {
      const config = resolveConfig({ name: 'mcp-routes-test' });
      const toolRegistry = new ToolRegistry();
      const resourceRegistry = new ResourceRegistry();
      const promptRegistry = new PromptRegistry();
      const contextManager = new ContextManager();
      const metrics = { startedAt: new Date().toISOString(), activeSessions: 0, totalSessions: 0 };
      const analytics = new AnalyticsCollector();
      const sessions = new Map<string, any>();

      const hono = createHonoApp({
        config,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        metrics,
        analytics,
        portProvider: () => 3000,
        sessions
      });

      // GET /mcp with missing session (lines 523-526)
      const getRes = await hono.request('/mcp');
      expect(getRes.status).toBe(400);
      const getText = await getRes.text();
      expect(getText).toContain('Invalid or missing session ID');

      // DELETE /mcp with invalid session (lines 533-536)
      const delRes = await hono.request('/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'invalid-session' }
      });
      expect(delRes.status).toBe(400);

      // DELETE /mcp with existing mock session (lines 538-550)
      let closedSession: string | null = null;
      const mockSession = {
        transport: {
          handleRequest: vi.fn().mockResolvedValue(new Response('OK', { status: 200 }))
        }
      };
      sessions.set('valid-session', mockSession);

      const honoWithCallback = createHonoApp({
        config,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        metrics,
        analytics,
        portProvider: () => 3000,
        sessions,
        onSessionClosed: (sid) => {
          closedSession = sid;
        }
      });

      const delValidRes = await honoWithCallback.request('/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'valid-session' }
      });
      expect(delValidRes.status).toBe(200);
      expect(closedSession).toBe('valid-session');
      expect(sessions.has('valid-session')).toBe(false);
    });

    it('executes system://metrics resource handler registered in hono', async () => {
      const config = resolveConfig({ name: 'metrics-resource-test' });
      const toolRegistry = new ToolRegistry();
      const resourceRegistry = new ResourceRegistry();
      const promptRegistry = new PromptRegistry();
      const contextManager = new ContextManager();
      const metrics = { startedAt: new Date().toISOString(), activeSessions: 1, totalSessions: 2 };
      const analytics = new AnalyticsCollector();

      createHonoApp({
        config,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        metrics,
        analytics,
        portProvider: () => 3000
      });

      // Get registered system://metrics resource (lines 327-345)
      const metricsResource = resourceRegistry.get('system://metrics');
      expect(metricsResource).toBeDefined();
      const raw = await metricsResource!.handler(new URL('system://metrics'), undefined as any);
      expect(raw).toBeDefined();
      expect((raw as any).contents[0].text).toContain('mcp_server_info');
    });

    it('sets auth identity when token is passed on excluded or non-auth routes', async () => {
      // 1. Non-auth server with token query param (lines 243-244)
      const configNoAuth = resolveConfig({ name: 'no-auth' });
      const honoNoAuth = createHonoApp({
        config: configNoAuth,
        toolRegistry: new ToolRegistry(),
        resourceRegistry: new ResourceRegistry(),
        promptRegistry: new PromptRegistry(),
        contextManager: new ContextManager(),
        metrics: { startedAt: new Date().toISOString(), activeSessions: 0, totalSessions: 0 },
        analytics: new AnalyticsCollector(),
        portProvider: () => 3000
      });

      const resNoAuth = await honoNoAuth.request('/health?token=abc');
      expect(resNoAuth.status).toBe(200);

      // 2. Auth server with token on excluded route /health (lines 195-196)
      const configAuth = resolveConfig({
        name: 'auth-server',
        apiKey: 'secret-key',
        auth: {
          excludePaths: ['/health']
        }
      });
      const honoAuth = createHonoApp({
        config: configAuth,
        toolRegistry: new ToolRegistry(),
        resourceRegistry: new ResourceRegistry(),
        promptRegistry: new PromptRegistry(),
        contextManager: new ContextManager(),
        metrics: { startedAt: new Date().toISOString(), activeSessions: 0, totalSessions: 0 },
        analytics: new AnalyticsCollector(),
        portProvider: () => 3000
      });

      const resAuthExcluded = await honoAuth.request('/health?token=my-token');
      expect(resAuthExcluded.status).toBe(200);
    });
  });

  describe('McpApp programmatic methods', () => {
    it('exercises helper methods: getTools, getTool, getPrompt, readLogs, getLogDirectory, getInspectorUrl, status, notifyResourceUpdated, notifyResourceListChanged', async () => {
      const server = createMcpServer({
        name: 'app-methods-test',
        port: 0,
        dataDir: `./.mcponce-test-methods-${Date.now()}`
      });
      app = server;

      // Filtered middleware via use(filter, handler) (lines 187-196)
      server.use('test_*', async (ctx, next) => next());

      server.tool({
        name: 'test_tool',
        description: 'Test Tool',
        handler: async () => 'ok'
      });

      server.prompt({
        name: 'test_prompt',
        handler: async () => ({ messages: [] })
      });

      // getTools, getTool, getPrompt
      expect(server.getTools().length).toBe(1);
      expect(server.getTool('test_tool')?.name).toBe('test_tool');
      expect(server.getPrompt('test_prompt')?.name).toBe('test_prompt');

      // Status before start (status === 'stopped')
      const initialStatus = await server.status();
      expect(initialStatus.status).toBe('stopped');

      // getLogDirectory & readLogs
      const logDir = await server.getLogDirectory();
      expect(logDir).toBeDefined();
      const logs = await server.readLogs(10);
      expect(Array.isArray(logs)).toBe(true);

      // Start server
      const startRes = await server.start();
      expect(startRes.role).toBe('owner');

      // Status after start (status === 'running')
      const runningStatus = await server.status();
      expect(runningStatus.status).toBe('running');
      expect(runningStatus.port).toBe(startRes.port);

      // getInspectorUrl
      const inspectorUrl = server.getInspectorUrl();
      expect(inspectorUrl).toContain(`:${startRes.port}/inspect`);
      const customInspectorUrl = server.getInspectorUrl('127.0.0.1');
      expect(customInspectorUrl).toContain('http://127.0.0.1:');

      // Resource listener & notifications
      let notifiedUri: string | null = null;
      const unbind = server.onResourceUpdated((uri) => {
        notifiedUri = uri;
      });

      const updatedCount = await server.notifyResourceUpdated('custom://item');
      expect(notifiedUri).toBe('custom://item');
      expect(updatedCount).toBe(0); // 0 connected remote sessions

      const listChangedCount = await server.notifyResourceListChanged();
      expect(listChangedCount).toBe(0);

      unbind();

      // Subscribed resources queries
      expect(server.getSubscribedResources()).toEqual([]);
      expect(server.getSubscribedResources('nonexistent-session')).toEqual([]);

      // Stop server
      await server.stop();
      expect((await server.status()).status).toBe('stopped');
    });
  });
});
