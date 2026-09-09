---
title: TypeScript Types
description: Complete TypeScript type signatures and interface declarations exported by mcponce.
---

# TypeScript Types

All interfaces and types are exported directly from the top-level `'mcponce'` package.

```typescript
import type {
  McpServerConfig,
  ToolDefinition,
  ToolExtra,
  CallOptions,
  ToolCacheConfig,
  ToolRetryConfig,
  ToolMiddlewareContext,
  ToolMiddlewareHandler,
  ToolProgressReport,
  ToolProgressNotification,
  ServerAnalytics,
  ResourceDefinition,
  PromptDefinition
} from 'mcponce';
```

---

## Tool Definitions

```typescript
export interface ToolDefinition<TInput = any, TContext = unknown> {
  name: string;
  description?: string;
  inputSchema?: InputSchemaDefinition;
  timeoutMs?: number;
  sequential?: boolean | string;
  maxConcurrency?: number;
  cache?: boolean | ToolCacheConfig;
  retry?: number | ToolRetryConfig;
  coerceInputs?: boolean;
  middleware?: ToolMiddlewareHandler<TContext>[];
  handler: (
    input: TInput,
    context: TContext & {
      callTool?: ToolExtra['callTool'];
      signal?: AbortSignal;
      clearCache?: ToolExtra['clearCache'];
      reportProgress?: ToolProgressReporter;
    },
    extra: ToolExtra
  ) => Promise<any> | any;
}
```

---

## Tool Execution Context (`ToolExtra`)

```typescript
export interface ToolExtra {
  signal?: AbortSignal;
  callTool: <TResult = any>(
    name: string,
    args?: Record<string, any>,
    options?: CallOptions
  ) => Promise<ToolCallResult<TResult>>;
  clearCache: (toolName?: string) => number;
  reportProgress: ToolProgressReporter;
  progressToken?: string | number;
}
```

---

## Programmatic Invocation Options (`CallOptions`)

```typescript
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  throwOnError?: boolean;
  sequential?: boolean | string;
  noCache?: boolean;
  bypassCache?: boolean;
  retry?: number | ToolRetryConfig | false;
  coerceInputs?: boolean;
  onProgress?: (progress: ToolProgressNotification) => void | Promise<void>;
  progressToken?: string | number;
}
```

---

## Caching & Retries

```typescript
export interface ToolCacheConfig {
  ttlMs?: number;
  maxSize?: number;
  keyGenerator?: (args: Record<string, any>) => string;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface ToolRetryConfig {
  attempts: number;
  backoffMs?: number;
  factor?: number;
  maxBackoffMs?: number;
  retryIf?: (error: any) => boolean;
}
```

---

## Middleware & Progress

```typescript
export interface ToolMiddlewareContext<TContext = any> {
  tool: string;
  args: Record<string, any>;
  context: TContext;
  extra: ToolExtra;
  options?: CallOptions;
  callStack: string[];
}

export type ToolMiddlewareHandler<TContext = any> = (
  ctx: ToolMiddlewareContext<TContext>,
  next: () => Promise<any>
) => Promise<any> | any;

export interface ToolProgressReport {
  progress: number;
  total?: number;
  message?: string;
}

export interface ToolProgressNotification extends ToolProgressReport {
  tool: string;
  progressToken?: string | number;
  timestamp: string;
}
```

---

## Telemetry & Analytics

```typescript
export interface ServerAnalytics {
  startedAt: string;
  generatedAt: string;
  summary: ServerAnalyticsSummary;
  tools: Record<string, ToolMetric>;
  interToolCalls: InterToolRelationship[];
  recentInvocations: RecentToolInvocation[];
}

export interface ServerAnalyticsSummary {
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  timeoutInvocations: number;
  cancelledInvocations: number;
  cachedInvocations?: number;
  totalRetries?: number;
  totalExecutionTimeMs: number;
  averageExecutionTimeMs: number;
  totalInterToolCalls: number;
}
```
