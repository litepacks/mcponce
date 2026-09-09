import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpServer,
  SubscriptionRegistry
} from '../src/index.js';
import { createSessionMcpServer } from '../src/server/mcp.js';
import { ContextManager } from '../src/server/context.js';
import { ToolRegistry } from '../src/registry/tools.js';
import { PromptRegistry } from '../src/registry/prompts.js';
import { MiddlewareManager } from '../src/utils/middleware.js';

describe('Resource Subscriptions & Live Updates', () => {
  describe('Unit: SubscriptionRegistry', () => {
    it('manages sessions and their subscribed resource URIs', () => {
      const registry = new SubscriptionRegistry();

      expect(registry.activeSubscriptionCount).toBe(0);
      registry.subscribe('session-1', 'orders://123');
      registry.subscribe('session-1', 'users://alice');
      registry.subscribe('session-2', 'orders://123');

      expect(registry.isSubscribed('session-1', 'orders://123')).toBe(true);
      expect(registry.isSubscribed('session-1', 'users://alice')).toBe(true);
      expect(registry.isSubscribed('session-2', 'orders://123')).toBe(true);
      expect(registry.isSubscribed('session-2', 'users://alice')).toBe(false);

      expect(registry.getSubscribers('orders://123')).toEqual(['session-1', 'session-2']);
      expect(registry.getSubscribers('users://alice')).toEqual(['session-1']);
      expect(registry.getSubscriptions('session-1')).toEqual(['orders://123', 'users://alice']);

      // Unsubscribe
      registry.unsubscribe('session-1', 'orders://123');
      expect(registry.isSubscribed('session-1', 'orders://123')).toBe(false);
      expect(registry.getSubscribers('orders://123')).toEqual(['session-2']);

      // Remove session
      registry.removeSession('session-2');
      expect(registry.getSubscribers('orders://123')).toEqual([]);
      expect(registry.getSubscriptions('session-2')).toEqual([]);
    });
  });

  describe('Integration: MCP Client Subscriptions & Live Notifications', () => {
    it('allows client to subscribe to resources and receive live notifications on update', async () => {
      const app = createMcpServer({
        name: 'live-data-server',
        version: '1.0.0'
      });

      let orderStatus = 'pending';
      app.resource({
        uri: 'orders://ord-1/status',
        name: 'Order Status',
        handler: () => ({ status: orderStatus })
      });

      const toolRegistry = new ToolRegistry();
      const promptRegistry = new PromptRegistry();
      const contextManager = new ContextManager();
      await contextManager.initialize();
      const middlewareManager = new MiddlewareManager();

      const sessionId = 'test-session-1';
      const server = createSessionMcpServer({
        name: app.config.name,
        version: app.config.version,
        toolRegistry,
        resourceRegistry: app.resourceRegistry,
        promptRegistry,
        contextManager,
        middlewareManager,
        sessionId,
        subscriptionRegistry: app.subscriptionRegistry,
        logger: app.logger
      });

      // Register session in app.sessions so notifyResourceUpdated can find it
      (app as any).sessions.set(sessionId, { server, transport: {} });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);

      // Verify server advertised subscribe capability
      const serverCapabilities = client.getServerCapabilities();
      expect(serverCapabilities?.resources?.subscribe).toBe(true);
      expect(serverCapabilities?.resources?.listChanged).toBe(true);

      // Listen for notifications on client
      const receivedNotifications: string[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notif) => {
        receivedNotifications.push(notif.params.uri);
      });

      let listChangedReceived = false;
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        listChangedReceived = true;
      });

      // 1. Client subscribes to the resource
      await client.subscribeResource({ uri: 'orders://ord-1/status' });
      expect(app.getSubscribedResources(sessionId)).toEqual(['orders://ord-1/status']);

      // 2. Server-side local listener
      const localUpdates: string[] = [];
      const unsubLocal = app.onResourceUpdated((uri) => {
        localUpdates.push(uri);
      });

      // 3. Trigger resource update on server
      orderStatus = 'shipped';
      const notified = await app.notifyResourceUpdated('orders://ord-1/status');
      expect(notified).toBe(1);
      expect(localUpdates).toEqual(['orders://ord-1/status']);
      expect(receivedNotifications).toEqual(['orders://ord-1/status']);

      // 4. Trigger resource list changed
      await app.notifyResourceListChanged();
      expect(listChangedReceived).toBe(true);

      // 5. Unsubscribe
      await client.unsubscribeResource({ uri: 'orders://ord-1/status' });
      expect(app.getSubscribedResources(sessionId)).toEqual([]);

      unsubLocal();
      await client.close();
      await server.close();
    });
  });
});

describe('HTTP Bearer Token & API Key Authentication', () => {
  it('protects endpoints with API key while leaving /health public', async () => {
    const app = createMcpServer({
      name: 'auth-server',
      apiKey: 'my-super-secret-token',
      port: 0
    });

    app.tool({
      name: 'secure_echo',
      handler: () => 'authenticated!'
    });

    const startResult = await app.start();
    const baseUrl = `http://127.0.0.1:${startResult.port}`;

    try {
      // 1. Public health check works without credentials
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json();
      expect(healthJson.ok).toBe(true);

      // 2. Request to /mcp without credentials returns 401 Unauthorized
      const unauthorizedRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      expect(unauthorizedRes.status).toBe(401);
      const unauthJson = await unauthorizedRes.json();
      expect(unauthJson.error.message).toContain('Unauthorized');

      // 3. Request with wrong token returns 401
      const wrongTokenRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      expect(wrongTokenRes.status).toBe(401);

      // 4. Request with valid Bearer token succeeds
      const authBearerRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer my-super-secret-token'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      // Streamable HTTP endpoint accepts request and doesn't return 401
      expect(authBearerRes.status).not.toBe(401);

      // 5. Request with X-API-Key header succeeds
      const authHeaderRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'my-super-secret-token'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      expect(authHeaderRes.status).not.toBe(401);
    } finally {
      await app.stop();
    }
  });

  it('supports multiple valid API keys in array', async () => {
    const app = createMcpServer({
      name: 'multi-key-server',
      apiKey: ['client-key-alpha', 'client-key-beta'],
      port: 0
    });

    const startResult = await app.start();
    const baseUrl = `http://127.0.0.1:${startResult.port}`;

    try {
      // Key Alpha
      const resAlpha = await fetch(`${baseUrl}/analytics`, {
        headers: { Authorization: 'Bearer client-key-alpha' }
      });
      expect(resAlpha.status).toBe(200);

      // Key Beta
      const resBeta = await fetch(`${baseUrl}/analytics`, {
        headers: { 'x-api-key': 'client-key-beta' }
      });
      expect(resBeta.status).toBe(200);

      // Key Gamma (Invalid)
      const resGamma = await fetch(`${baseUrl}/analytics`, {
        headers: { Authorization: 'Bearer client-key-gamma' }
      });
      expect(resGamma.status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});
