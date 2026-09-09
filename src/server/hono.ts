import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ResolvedConfig } from '../runtime/config.js';
import type { ToolRegistry } from '../registry/tools.js';
import type { ResourceRegistry } from '../registry/resources.js';
import type { PromptRegistry } from '../registry/prompts.js';
import type { ContextManager } from './context.js';
import { createSessionMcpServer } from './mcp.js';
import { setupInspectorRoutes } from './inspector.js';
import type { AnalyticsCollector } from './analytics.js';
import { RateLimiter, extractAuthToken } from '../utils/security.js';
import type { Logger, ToolDefinition, AuthIdentity } from '../types.js';
import type { QueueManager } from '../utils/queue.js';
import type { ToolCacheManager } from '../utils/cache.js';
import type { MiddlewareManager } from '../utils/middleware.js';
import type { SubscriptionRegistry } from '../registry/subscriptions.js';
import type { SampleHandler, ListRootsHandler, Root } from '../utils/sampling.js';

export interface ServerMetrics {
  startedAt: string;
  activeSessions: number;
  totalSessions: number;
  lastClientConnection?: string;
  lastToolInvocation?: {
    name: string;
    timestamp: string;
  };
}

export function createHonoApp<TContext = unknown>(options: {
  config: ResolvedConfig<TContext>;
  toolRegistry: ToolRegistry<TContext>;
  resourceRegistry: ResourceRegistry<TContext>;
  promptRegistry: PromptRegistry<TContext>;
  contextManager: ContextManager<TContext>;
  metrics: ServerMetrics;
  analytics: AnalyticsCollector;
  portProvider: () => number;
  callTool?: (name: string, args?: Record<string, any>, options?: any, callStack?: string[]) => Promise<any>;
  logger?: Logger;
  queueManager?: QueueManager;
  cacheManager?: ToolCacheManager;
  middlewareManager?: MiddlewareManager<TContext>;
  resolveQueueConfig?: (tool: ToolDefinition<any, TContext>, options?: any) => { key: string; maxConcurrency: number } | null;
  sessions: Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: any; auth?: AuthIdentity }>;
  subscriptionRegistry?: SubscriptionRegistry;
  onSessionClosed?: (sessionId: string) => void;
  onSample?: SampleHandler;
  onListRoots?: ListRootsHandler;
  onRootsListChanged?: (roots?: Root[]) => void;
}) {
  const {
    config,
    toolRegistry,
    resourceRegistry,
    promptRegistry,
    contextManager,
    metrics,
    analytics,
    portProvider,
    callTool,
    logger,
    queueManager,
    cacheManager,
    middlewareManager,
    resolveQueueConfig,
    sessions,
    subscriptionRegistry,
    onSessionClosed,
    onSample,
    onListRoots,
    onRootsListChanged
  } = options;

  const getSessionId = (c: any): string | undefined => {
    return (
      c.req.header('mcp-session-id') ||
      c.req.header('Mcp-Session-Id') ||
      c.req.query('sessionId') ||
      c.req.query('mcp-session-id')
    );
  };

  const app = new Hono();

  // Enterprise Security Headers
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-XSS-Protection', '1; mode=block');
    return next();
  });

  // Configurable CORS support
  const corsConfig = config.cors || {};
  let allowedOrigin: any = corsConfig.origin || '*';
  if (typeof corsConfig.origin === 'function') {
    allowedOrigin = (origin: string) => {
      const fn = corsConfig.origin as (o: string) => boolean | string | undefined | null;
      const res = fn(origin);
      if (typeof res === 'boolean') {
        return res ? origin : null;
      }
      return res;
    };
  }

  const allowCredentials = corsConfig.credentials ?? false;
  const allowHeaders = corsConfig.allowHeaders || [
    'Content-Type',
    'mcp-session-id',
    'Last-Event-ID',
    'mcp-protocol-version',
    'Authorization',
    'x-api-key',
    'X-API-Key'
  ];
  const exposeHeaders = corsConfig.exposeHeaders || ['mcp-session-id', 'mcp-protocol-version'];

  app.use(
    '*',
    cors({
      origin: allowedOrigin,
      credentials: allowCredentials,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders,
      exposeHeaders
    })
  );

  // Sliding window Rate Limiting middleware
  if (config.rateLimit) {
    const rateLimiter = new RateLimiter(config.rateLimit);
    app.use('*', async (c, next) => {
      // Exclude public health endpoint from rate limiting
      if (c.req.path === '/health') {
        return next();
      }

      const clientIp =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        'anonymous';
      const token = extractAuthToken(
        c.req.header() as Record<string, string | undefined>,
        c.req.query('token') || c.req.query('api_key')
      );
      const rateLimitKey = token || clientIp;

      const check = rateLimiter.check(rateLimitKey);
      c.header('X-RateLimit-Limit', String(config.rateLimit!.max));
      c.header('X-RateLimit-Remaining', String(check.remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(check.resetMs / 1000)));

      if (!check.allowed) {
        c.header('Retry-After', String(Math.ceil(check.resetMs / 1000)));
        return c.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32029,
              message: 'Too Many Requests: Rate limit exceeded'
            },
            id: null
          },
          429
        );
      }

      return next();
    });
  }

  // Authentication & Identity Middleware
  const hasGlobalAuth = Boolean(
    (config.apiKey && config.apiKey.length > 0) ||
    config.auth?.validate
  );

  app.use('*', async (c, next) => {
    const excluded = ['/health', ...(config.auth?.excludedPaths || [])];
    const isExcluded = excluded.includes(c.req.path);

    const token = extractAuthToken(
      c.req.header() as Record<string, string | undefined>,
      c.req.query('token') || c.req.query('api_key')
    );

    if (isExcluded) {
      if (token) {
        (c as any).set('auth', { token });
      }
      return next();
    }

    if (hasGlobalAuth) {
      if (config.auth?.validate) {
        const validated = await config.auth.validate(token, {
          path: c.req.path,
          method: c.req.method,
          headers: c.req.header() as Record<string, string | undefined>
        });

        if (!validated) {
          return c.json(
            {
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Unauthorized: Authentication validation failed'
              },
              id: null
            },
            401
          );
        }

        const identity: AuthIdentity =
          typeof validated === 'object' ? validated : { token, role: 'authenticated' };
        (c as any).set('auth', identity);
      } else if (config.apiKey && config.apiKey.length > 0) {
        if (!token || !config.apiKey.includes(token)) {
          return c.json(
            {
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message:
                  'Unauthorized: Invalid or missing API key. Provide Authorization: Bearer <key> or X-API-Key: <key>'
              },
              id: null
            },
            401
          );
        }
        (c as any).set('auth', { token, role: 'api_key' });
      }
    } else if (token) {
      (c as any).set('auth', { token });
    }

    return next();
  });

  // Health endpoint
  app.get('/health', (c) => {
    return c.json({
      ok: true,
      name: config.name,
      pid: process.pid,
      version: config.version
    });
  });

  // Diagnostics and server info endpoint
  app.get('/info', (c) => {
    return c.json({
      name: config.name,
      version: config.version,
      status: 'running',
      pid: process.pid,
      port: portProvider(),
      host: config.host,
      startedAt: metrics.startedAt,
      activeSessions: metrics.activeSessions,
      totalSessions: metrics.totalSessions,
      lastClientConnection: metrics.lastClientConnection,
      lastToolInvocation: metrics.lastToolInvocation,
      analytics: analytics.getSnapshot().summary
    });
  });

  // Analytics endpoint returning complete metrics snapshot
  app.get('/analytics', (c) => {
    return c.json(analytics.getSnapshot());
  });

  // Prometheus metrics endpoint (standard 0.0.4 exposition format)
  app.get('/metrics', (c) => {
    const uptimeSeconds = (Date.now() - new Date(metrics.startedAt).getTime()) / 1000;
    const body = analytics.toPrometheusFormat({
      serverName: config.name,
      version: config.version,
      activeSessions: metrics.activeSessions,
      totalSessions: metrics.totalSessions,
      uptimeSeconds: Math.max(0, uptimeSeconds),
      cacheStats: cacheManager?.getStats()
    });
    return c.text(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
    });
  });

  // Register built-in resource for MCP clients to inspect analytics
  try {
    resourceRegistry.register({
      uri: 'system://analytics',
      name: 'Server Analytics',
      description: 'Real-time tool execution metrics and inter-tool call graph',
      mimeType: 'application/json',
      handler: () => {
        return {
          contents: [
            {
              uri: 'system://analytics',
              mimeType: 'application/json',
              text: JSON.stringify(analytics.getSnapshot(), null, 2)
            }
          ]
        };
      }
    });
  } catch {}

  // Register built-in resource for MCP clients to inspect Prometheus metrics
  try {
    resourceRegistry.register({
      uri: 'system://metrics',
      name: 'Prometheus Metrics',
      description: 'Standard Prometheus text exposition metrics for scraping',
      mimeType: 'text/plain; version=0.0.4; charset=utf-8',
      handler: () => {
        const uptimeSeconds = (Date.now() - new Date(metrics.startedAt).getTime()) / 1000;
        const text = analytics.toPrometheusFormat({
          serverName: config.name,
          version: config.version,
          activeSessions: metrics.activeSessions,
          totalSessions: metrics.totalSessions,
          uptimeSeconds: Math.max(0, uptimeSeconds),
          cacheStats: cacheManager?.getStats()
        });
        return {
          contents: [
            {
              uri: 'system://metrics',
              mimeType: 'text/plain; version=0.0.4; charset=utf-8',
              text
            }
          ]
        };
      }
    });
  } catch {}

  // Mount Web Inspector & API routes
  setupInspectorRoutes(app, {
    serverName: config.name,
    version: config.version,
    toolRegistry,
    resourceRegistry,
    promptRegistry,
    analytics,
    metrics,
    portProvider,
    callTool,
    context: undefined
  });

  // MCP POST handler
  app.post('/mcp', async (c) => {
    const sessionId = getSessionId(c);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        return session.transport.handleRequest(c.req.raw);
      }
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found'
          },
          id: null
        },
        404
      );
    }

    // No session ID in header: check request body
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: 'Parse error: Invalid JSON'
          },
          id: null
        },
        400
      );
    }

    if (!body || typeof body !== 'object') {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request: Body must be a JSON object'
          },
          id: null
        },
        400
      );
    }

    if (isInitializeRequest(body)) {
      // Create a stateful transport for this new session
      const clientAuth = (c as any).get('auth') as AuthIdentity | undefined;
      const sid = randomUUID();
      let server: any = null;
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => sid,
        onsessioninitialized: (actualSid) => {
          sessions.set(actualSid, { transport, server, auth: clientAuth });
          metrics.activeSessions = sessions.size;
          metrics.totalSessions++;
          metrics.lastClientConnection = new Date().toISOString();
          logger?.info('client:connect', { session: actualSid });
        },
        onsessionclosed: (actualSid) => {
          if (sessions.has(actualSid)) {
            sessions.delete(actualSid);
            subscriptionRegistry?.removeSession(actualSid);
            metrics.activeSessions = sessions.size;
            logger?.info('client:disconnect', { session: actualSid });
            onSessionClosed?.(actualSid);
          }
        }
      });

      server = createSessionMcpServer({
        name: config.name,
        version: config.version,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        sessionId: sid,
        subscriptionRegistry,
        defaultTimeoutMs: config.toolTimeoutMs,
        queueManager,
        cacheManager,
        middlewareManager,
        resolveQueueConfig,
        callTool,
        logger,
        onSample,
        onListRoots,
        onRootsListChanged,
        auth: clientAuth,
        analytics,
        metrics,
        onToolCalled: (toolName) => {
          metrics.lastToolInvocation = {
            name: toolName,
            timestamp: new Date().toISOString()
          };
        }
      });

      await server.connect(transport);
      return transport.handleRequest(c.req.raw, { parsedBody: body });
    }

    // Stateless fallback: request without session ID and not initialize
    try {
      const clientAuth = (c as any).get('auth') as AuthIdentity | undefined;
      const statelessTransport = new WebStandardStreamableHTTPServerTransport();
      const statelessServer = createSessionMcpServer({
        name: config.name,
        version: config.version,
        toolRegistry,
        resourceRegistry,
        promptRegistry,
        contextManager,
        subscriptionRegistry,
        defaultTimeoutMs: config.toolTimeoutMs,
        queueManager,
        cacheManager,
        middlewareManager,
        resolveQueueConfig,
        callTool,
        logger,
        onSample,
        onListRoots,
        onRootsListChanged,
        auth: clientAuth,
        analytics,
        metrics,
        onToolCalled: (toolName) => {
          metrics.lastToolInvocation = {
            name: toolName,
            timestamp: new Date().toISOString()
          };
        }
      });
      await statelessServer.connect(statelessTransport);
      return statelessTransport.handleRequest(c.req.raw, { parsedBody: body });
    } catch (err: any) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${err.message || String(err)}`
          },
          id: null
        },
        500
      );
    }
  });

  // MCP GET handler (SSE stream)
  app.get('/mcp', async (c) => {
    const sessionId = getSessionId(c);
    if (!sessionId || !sessions.has(sessionId)) {
      return c.text('Invalid or missing session ID', 400);
    }
    const session = sessions.get(sessionId)!;
    return session.transport.handleRequest(c.req.raw);
  });

  // MCP DELETE handler (session termination)
  app.delete('/mcp', async (c) => {
    const sessionId = getSessionId(c);
    if (!sessionId || !sessions.has(sessionId)) {
      return c.text('Invalid or missing session ID', 400);
    }
    const session = sessions.get(sessionId)!;
    try {
      const response = await session.transport.handleRequest(c.req.raw);
      sessions.delete(sessionId);
      metrics.activeSessions = sessions.size;
      logger?.info('client:disconnect', { session: sessionId });
      onSessionClosed?.(sessionId);
      return response;
    } catch {
      sessions.delete(sessionId);
      metrics.activeSessions = sessions.size;
      logger?.info('client:disconnect', { session: sessionId });
      onSessionClosed?.(sessionId);
      return c.text('Session closed', 200);
    }
  });

  return app;
}
