import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  RootsListChangedNotificationSchema,
  CompleteRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { resolveCompletion } from '../utils/completion.js';
import type { ToolRegistry } from '../registry/tools.js';
import type { ResourceRegistry } from '../registry/resources.js';
import type { SubscriptionRegistry } from '../registry/subscriptions.js';
import type { PromptRegistry } from '../registry/prompts.js';
import type { ContextManager } from './context.js';
import type { Logger, ToolCallResult, ToolExtra, AuthIdentity } from '../types.js';
import { createProgressReporter } from '../utils/progress.js';
import { composeMiddleware, type MiddlewareManager } from '../utils/middleware.js';
import { verifyToolScopes } from '../utils/security.js';
import {
  executeSample,
  executeListRoots,
  type SampleHandler,
  type ListRootsHandler,
  type Root,
  type SampleOptions
} from '../utils/sampling.js';

import {
  normalizeContentItem,
  normalizeResourceResult,
  ImageContentHelper,
  isImageContent,
  isTextContent,
  isEmbeddedResource
} from '../utils/media.js';

export function normalizeToolResult<TData = any>(rawResult: any): ToolCallResult<TData> {
  if (rawResult === undefined || rawResult === null) {
    return {
      content: [],
      data: rawResult as unknown as TData,
      text: ''
    };
  }

  // Direct ImageContentHelper or isImageContent
  if (rawResult instanceof ImageContentHelper) {
    const item = rawResult.toJSON();
    return {
      content: [item],
      data: rawResult as unknown as TData,
      text: `[Image: ${item.mimeType}]`
    };
  }

  if (isImageContent(rawResult)) {
    return {
      content: [rawResult],
      data: rawResult as unknown as TData,
      text: `[Image: ${rawResult.mimeType}]`
    };
  }

  // Direct Buffer or Uint8Array returned by tool
  if (Buffer.isBuffer(rawResult) || rawResult instanceof Uint8Array) {
    const img = normalizeContentItem(rawResult);
    const mime = (img as any).mimeType || 'application/octet-stream';
    return {
      content: [img],
      data: rawResult as unknown as TData,
      text: `[Image: ${mime}]`
    };
  }

  // Standard MCP result with content array
  if (rawResult && typeof rawResult === 'object' && Array.isArray((rawResult as any).content)) {
    const normalizedContent = (rawResult as any).content.map(normalizeContentItem);
    const textPieces = normalizedContent
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text);
    const fallbackText =
      textPieces.length > 0
        ? textPieces.join('\n')
        : normalizedContent.map((c: any) => (c.type === 'image' ? `[Image: ${c.mimeType}]` : `[${c.type}]`)).join(' ');

    return {
      ...rawResult,
      content: normalizedContent,
      data: rawResult.data !== undefined ? rawResult.data : rawResult,
      text: rawResult.text !== undefined ? rawResult.text : fallbackText
    };
  }

  // Array of mixed items (e.g. ['Screenshot:', imageBuffer])
  if (Array.isArray(rawResult)) {
    const normalizedContent = rawResult.map(normalizeContentItem);
    const textPieces = normalizedContent
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text);
    const fallbackText =
      textPieces.length > 0
        ? textPieces.join('\n')
        : normalizedContent.map((c: any) => (c.type === 'image' ? `[Image: ${c.mimeType}]` : `[${c.type}]`)).join(' ');

    return {
      content: normalizedContent,
      data: rawResult as unknown as TData,
      text: fallbackText
    };
  }

  // Shorthand object with image / resource
  if (
    rawResult &&
    typeof rawResult === 'object' &&
    ('image' in rawResult || 'resource' in rawResult)
  ) {
    const item = normalizeContentItem(rawResult);
    const content = [item];
    if ('text' in rawResult && typeof rawResult.text === 'string' && rawResult.text.trim()) {
      content.unshift({ type: 'text', text: rawResult.text });
    }
    const textDesc =
      rawResult.text || (item.type === 'image' ? `[Image: ${item.mimeType}]` : `[${item.type}]`);

    return {
      content,
      data: rawResult as unknown as TData,
      text: textDesc
    };
  }

  if (typeof rawResult === 'string') {
    return {
      content: [{ type: 'text', text: rawResult }],
      data: rawResult as unknown as TData,
      text: rawResult
    };
  }

  let text = '';
  try {
    text = JSON.stringify(rawResult);
  } catch {
    text = String(rawResult);
  }
  return {
    content: [{ type: 'text', text }],
    data: rawResult as unknown as TData,
    text
  };
}

import type { ToolDefinition } from '../types.js';
import type { QueueManager } from '../utils/queue.js';
import type { ToolCacheManager } from '../utils/cache.js';
import { executeWithRetry, raceWithSignal } from '../utils/retry.js';
import type { AnalyticsCollector } from './analytics.js';
import type { ServerMetrics } from './hono.js';

export function createSessionMcpServer<TContext = unknown>(options: {
  name: string;
  version: string;
  toolRegistry: ToolRegistry<TContext>;
  resourceRegistry: ResourceRegistry<TContext>;
  promptRegistry: PromptRegistry<TContext>;
  contextManager: ContextManager<TContext>;
  defaultTimeoutMs?: number;
  queueManager?: QueueManager;
  cacheManager?: ToolCacheManager;
  middlewareManager?: MiddlewareManager<TContext>;
  resolveQueueConfig?: (tool: ToolDefinition<any, TContext>, options?: any) => { key: string; maxConcurrency: number } | null;
  callTool?: <TResult = any>(
    name: string,
    args?: Record<string, any>,
    options?: any,
    callStack?: string[]
  ) => Promise<ToolCallResult<TResult>>;
  logger?: Logger;
  onToolCalled?: (name: string) => void;
  sessionId?: string;
  subscriptionRegistry?: SubscriptionRegistry;
  onSubscribe?: (uri: string, sessionId?: string) => void;
  onUnsubscribe?: (uri: string, sessionId?: string) => void;
  onSample?: SampleHandler;
  onListRoots?: ListRootsHandler;
  onRootsListChanged?: (roots?: Root[]) => void;
  auth?: AuthIdentity;
  analytics?: AnalyticsCollector;
  metrics?: ServerMetrics;
}): McpServer {
  const server = new McpServer({
    name: options.name,
    version: options.version
  });

  // Register capabilities for resource subscriptions and list updates
  server.server.registerCapabilities({
    resources: {
      subscribe: true,
      listChanged: true
    }
  });

  // Handle client resource subscriptions
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (options.subscriptionRegistry && options.sessionId) {
      options.subscriptionRegistry.subscribe(options.sessionId, uri);
    }
    options.onSubscribe?.(uri, options.sessionId);
    return {};
  });

  // Handle client resource unsubscriptions
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (options.subscriptionRegistry && options.sessionId) {
      options.subscriptionRegistry.unsubscribe(options.sessionId, uri);
    }
    options.onUnsubscribe?.(uri, options.sessionId);
    return {};
  });

  // Handle client roots list changed notification
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    options.logger?.info('client:roots_list_changed', { session: options.sessionId });
    try {
      const rootsRes = await server.server.listRoots();
      options.onRootsListChanged?.(rootsRes?.roots);
    } catch {
      options.onRootsListChanged?.();
    }
  });

  const ctx = options.contextManager.getContext();

  // Register all tools
  for (const tool of options.toolRegistry.getAll()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.normalizedSchema
      },
      async (args: any, extraFromMcp?: any) => {
        const start = Date.now();
        options.logger?.info('tool:start', { name: tool.name });
        options.onToolCalled?.(tool.name);

        if (tool.requireAuth && !options.auth) {
          throw new Error(`Authentication required for tool "${tool.name}"`);
        }

        if (tool.scopes && tool.scopes.length > 0) {
          if (!verifyToolScopes(tool.scopes, options.auth?.scopes)) {
            throw new Error(
              `Forbidden: Tool "${tool.name}" requires scopes: ${tool.scopes.join(', ')}`
            );
          }
        }

        const cacheConfig = typeof tool.cache === 'object' ? tool.cache : (tool.cache ? {} : undefined);
        if (cacheConfig && options.cacheManager) {
          const cached = options.cacheManager.get(tool.name, args, cacheConfig);
          if (cached) {
            const durationMs = Date.now() - start;
            options.analytics?.recordInvocation({
              tool: tool.name,
              durationMs,
              status: 'success',
              isCacheHit: true
            });
            if (options.metrics) {
              options.metrics.lastToolInvocation = {
                name: tool.name,
                timestamp: new Date().toISOString()
              };
            }
            options.logger?.info('tool:cache_hit', { name: tool.name, durationMs });
            return normalizeToolResult(cached);
          }
        }

        const effectiveTimeout =
          tool.timeoutMs !== undefined
            ? tool.timeoutMs
            : (options.defaultTimeoutMs !== undefined ? options.defaultTimeoutMs : 60000);

        const timeoutController = effectiveTimeout > 0 ? new AbortController() : null;
        let timeoutTimer: NodeJS.Timeout | undefined;
        if (effectiveTimeout > 0 && timeoutController) {
          timeoutTimer = setTimeout(() => {
            timeoutController.abort(
              new Error(`Tool "${tool.name}" execution timed out after ${effectiveTimeout}ms`)
            );
          }, effectiveTimeout);
        }

        const signals: AbortSignal[] = [];
        if (extraFromMcp?.signal) {
          signals.push(extraFromMcp.signal);
        }
        if (timeoutController) {
          signals.push(timeoutController.signal);
        }

        const mergedSignal =
          signals.length > 1
            ? (typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0])
            : signals[0];

        const queueConfig = options.resolveQueueConfig?.(tool);
        let release: (() => void) | undefined;
        let retriesCount = 0;

        try {
          if (queueConfig && options.queueManager) {
            release = await options.queueManager.getQueue(queueConfig.key, queueConfig.maxConcurrency).acquire(mergedSignal);
          }

          const callToolHelper = options.callTool
            ? <T = any>(
                targetName: string,
                targetArgs: Record<string, any> = {},
                targetOptions?: any
              ) => {
                const mergedTargetOptions = {
                  ...targetOptions,
                  auth: targetOptions?.auth || options.auth
                };
                return options.callTool!<T>(targetName, targetArgs, mergedTargetOptions, [tool.name]);
              }
            : undefined;

          const clearCacheHelper = (targetToolName?: string) => {
            return options.cacheManager ? options.cacheManager.clear(targetToolName) : 0;
          };

          const progressToken = extraFromMcp?._meta?.progressToken;
          const reportProgress = createProgressReporter({
            toolName: tool.name,
            progressToken,
            sendMcpNotification: extraFromMcp?.sendNotification
              ? (notif) => extraFromMcp.sendNotification(notif)
              : undefined,
            logger: options.logger
          });

          const sampleHelper = (input: string | SampleOptions, opts?: Partial<SampleOptions>) => {
            return executeSample(input, opts, server, options.onSample, mergedSignal);
          };

          const listRootsHelper = () => {
            return executeListRoots(server, options.onListRoots, mergedSignal);
          };

          const handlerCtx =
            ctx && typeof ctx === 'object'
              ? (callToolHelper
                  ? Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
                      callTool: callToolHelper,
                      signal: mergedSignal,
                      clearCache: clearCacheHelper,
                      reportProgress,
                      sample: sampleHelper,
                      listRoots: listRootsHelper,
                      auth: options.auth
                    })
                  : Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
                      signal: mergedSignal,
                      clearCache: clearCacheHelper,
                      reportProgress,
                      sample: sampleHelper,
                      listRoots: listRootsHelper,
                      auth: options.auth
                    }))
              : {
                  callTool: callToolHelper,
                  signal: mergedSignal,
                  clearCache: clearCacheHelper,
                  reportProgress,
                  sample: sampleHelper,
                  listRoots: listRootsHelper,
                  auth: options.auth
                };

          const extra: ToolExtra = {
            signal: mergedSignal,
            callTool: (callToolHelper || (() => Promise.reject(new Error('callTool is not available in this context')))) as any,
            clearCache: clearCacheHelper,
            reportProgress,
            progressToken,
            sample: sampleHelper,
            listRoots: listRootsHelper,
            auth: options.auth
          };

          const middlewarePipeline = options.middlewareManager
            ? options.middlewareManager.composeForTool(
                tool.name,
                (pCtx) => Promise.resolve(tool.handler(pCtx.args, pCtx.context, pCtx.extra)),
                tool.middleware
              )
            : tool.middleware && tool.middleware.length > 0
              ? composeMiddleware(
                  tool.middleware,
                  (pCtx) => Promise.resolve(tool.handler(pCtx.args, pCtx.context, pCtx.extra))
                )
              : null;

          const runAttempt = () => {
            if (middlewarePipeline) {
              const middlewareCtx = {
                tool: tool.name,
                args: args || {},
                context: handlerCtx,
                extra,
                callStack: []
              };
              const executionPromise = middlewarePipeline(middlewareCtx);
              return raceWithSignal(
                executionPromise,
                mergedSignal,
                () => new Error(`Tool "${tool.name}" execution was cancelled`)
              );
            }

            const executionPromise = Promise.resolve(tool.handler(args, handlerCtx, extra));
            return raceWithSignal(
              executionPromise,
              mergedSignal,
              () => new Error(`Tool "${tool.name}" execution was cancelled`)
            );
          };

          const { result: rawResult, retries } = await executeWithRetry(
            runAttempt,
            {
              name: tool.name,
              config: tool.retry,
              signal: mergedSignal,
              onRetry: (err, attempt, delayMs) => {
                options.logger?.warn('tool:retry', {
                  name: tool.name,
                  attempt,
                  delayMs,
                  error: err?.message || String(err)
                });
              }
            }
          );
          retriesCount = retries;

          const durationMs = Date.now() - start;
          const normalized = normalizeToolResult(rawResult);

          const status = normalized.isError ? 'error' : 'success';
          const errorMsg = normalized.isError ? (normalized.content?.[0] as any)?.text : undefined;

          options.analytics?.recordInvocation({
            tool: tool.name,
            durationMs,
            status,
            errorMessage: errorMsg,
            retries: retriesCount
          });
          if (options.metrics) {
            options.metrics.lastToolInvocation = {
              name: tool.name,
              timestamp: new Date().toISOString()
            };
          }

          options.logger?.info('tool:end', { name: tool.name, durationMs });

          if (cacheConfig && options.cacheManager && !normalized.isError) {
            options.cacheManager.set(tool.name, args, normalized, cacheConfig);
          }
          return normalized;
        } catch (error: any) {
          const durationMs = Date.now() - start;
          const isTimeout = String(error?.message || error).includes('timed out');
          const isCancelled = Boolean(mergedSignal?.aborted && !isTimeout);
          const status = isTimeout ? 'timeout' : (isCancelled ? 'cancelled' : 'error');

          options.analytics?.recordInvocation({
            tool: tool.name,
            durationMs,
            status,
            errorMessage: error.message || String(error),
            retries: retriesCount || (error?.retries ?? 0)
          });
          if (options.metrics) {
            options.metrics.lastToolInvocation = {
              name: tool.name,
              timestamp: new Date().toISOString()
            };
          }

          options.logger?.error('tool:error', {
            name: tool.name,
            durationMs,
            isTimeout,
            isCancelled,
            error: error.message || String(error),
            stack: error.stack
          });

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Error in tool "${tool.name}": ${error.message || String(error)}`
              }
            ]
          };
        } finally {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          release?.();
        }
      }
    );
  }

  // Register all static resources
  for (const res of options.resourceRegistry.getAll()) {
    server.registerResource(
      res.name || res.uri,
      res.uri,
      {
        description: res.description,
        mimeType: res.mimeType
      },
      async (uri: URL) => {
        const raw = await res.handler(uri, ctx);
        return normalizeResourceResult(raw, uri, res.mimeType);
      }
    );
  }

  // Register all dynamic resource templates
  for (const tpl of options.resourceRegistry.getAllTemplates()) {
    const resourceTemplate = new ResourceTemplate(tpl.uriTemplate, {
      list: tpl.list
        ? async () => {
            const result = await tpl.list!(ctx);
            if (Array.isArray(result)) {
              return { resources: result };
            }
            return result;
          }
        : undefined,
      complete: tpl.complete
    });

    server.registerResource(
      tpl.name || tpl.uriTemplate,
      resourceTemplate,
      {
        description: tpl.description,
        mimeType: tpl.mimeType
      },
      async (uri: URL, variables: any) => {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(variables || {})) {
          params[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
        const raw = await tpl.handler(uri, params, ctx);
        return normalizeResourceResult(raw, uri, tpl.mimeType);
      }
    );
  }

  // Register all prompts
  for (const prompt of options.promptRegistry.getAll()) {
    let argsSchema = prompt.argsSchema;
    if (argsSchema && prompt.complete) {
      const wrappedSchema: Record<string, any> = {};
      for (const [key, field] of Object.entries(argsSchema)) {
        if (prompt.complete[key]) {
          wrappedSchema[key] = completable(field as any, async (val: string, context?: any) => {
            const list = await prompt.complete![key](val, context);
            return Array.isArray(list) ? list : [];
          });
        } else {
          wrappedSchema[key] = field;
        }
      }
      argsSchema = wrappedSchema;
    }

    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: argsSchema as any
      },
      async (args: any) => {
        return await prompt.handler(args, ctx);
      }
    );
  }

  // Register completion capability and fallback request handler if not yet registered
  try {
    server.server.registerCapabilities({
      completions: {}
    });
    server.server.setRequestHandler(CompleteRequestSchema, async (request) => {
      const result = await resolveCompletion({
        promptRegistry: options.promptRegistry,
        resourceRegistry: options.resourceRegistry,
        toolRegistry: options.toolRegistry,
        ref: request.params.ref as any,
        argument: request.params.argument as any,
        context: ctx
      });
      return {
        completion: {
          values: result.values,
          total: result.total,
          hasMore: result.hasMore
        }
      };
    });
  } catch {
    // Handler already configured by McpServer
  }

  return server;
}
