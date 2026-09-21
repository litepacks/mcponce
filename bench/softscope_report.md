# Softscope Report

## Runtime Overview

| Metric | Value |
| :--- | :--- |
| **Duration** | 17.70s |
| **Files observed** | 45 |
| **Functions discovered** | 426 |
| **Functions executed** | 131 |
| **Function calls** | 1,974,908 |
| **Runtime reach** | 30.8% executed (295 untouched) |

## Top Total Time

| Function | Location | Calls | Total | Self | Avg | Max |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `main` | `bench/run.js:13` | 1 | 14.13s | 973ms | 14.13s | 14.13s |
| `McpApp.callTool` | `dist/server/app.js:200` | 12,001 | 13.30s | 1.61s | 1.1ms | 114ms |
| `DefaultLogger.info` | `dist/logging/logger.js:47` | 22,606 | 7.81s | 44ms | 0.35ms | 52ms |
| `DefaultLogger.write` | `dist/logging/logger.js:29` | 22,607 | 7.76s | 95ms | 0.34ms | 52ms |
| `FileLoggerWriter.write` | `dist/logging/file-logger.js:56` | 22,606 | 7.65s | 7.28s | 0.34ms | 52ms |
| `executeWithRetry` | `dist/utils/retry.js:75` | 10,301 | 3.28s | 162ms | 0.32ms | 56ms |
| `handler` | `bench/run.js:77` | 2,000 | 2.17s | 1.9ms | 1.1ms | 56ms |
| `runAttempt` | `dist/server/app.js:385` | 10,001 | 2.02s | 160ms | 0.20ms | 41ms |
| `dispatch` | `dist/utils/middleware.js:42` | 16,301 | 1.68s | 129ms | 0.10ms | 41ms |
| `anonymous@40:12` | `dist/utils/middleware.js:40` | 10,301 | 1.59s | 46ms | 0.15ms | 41ms |
| `middlewareManager.composeForTool callback` | `dist/server/app.js:384` | 10,001 | 1.36s | 1.35s | 0.14ms | 41ms |
| `callToolHelper` | `dist/server/app.js:308` | 2,000 | 1.25s | 1.25s | 0.62ms | 41ms |
| `stableSerialize` | `dist/utils/cache.js:5` | 424,004 | 737ms | 268ms | 0.00ms | 5.8ms |
| `app.post callback` | `dist/server/hono.js:250` | 300 | 388ms | 221ms | 1.3ms | 16ms |
| `keys.map callback` | `dist/utils/cache.js:13` | 242,002 | 375ms | 165ms | 0.00ms | 5.8ms |
| `raceWithSignal` | `dist/utils/retry.js:37` | 10,301 | 373ms | 142ms | 0.04ms | 21ms |
| `normalizeInputSchema` | `dist/registry/tools.js:28` | 20,021 | 363ms | 195ms | 0.02ms | 2.5ms |
| `ToolCacheManager.generateKey` | `dist/utils/cache.js:31` | 42,002 | 357ms | 30ms | 0.01ms | 5.8ms |
| `formatLogLine` | `dist/logging/file-logger.js:4` | 22,606 | 275ms | 206ms | 0.01ms | 16ms |
| `AnalyticsCollector.recordInvocation` | `dist/server/analytics.js:24` | 32,301 | 274ms | 274ms | 0.01ms | 7.7ms |
| `ToolCacheManager.get` | `dist/utils/cache.js:40` | 22,001 | 247ms | 51ms | 0.01ms | 5.8ms |
| `normalizeToolResult` | `dist/server/mcp.js:10` | 10,301 | 232ms | 208ms | 0.02ms | 40ms |
| `anonymous@43:24` | `dist/utils/retry.js:43` | 10,301 | 231ms | 231ms | 0.02ms | 13ms |
| `server.registerTool callback` | `dist/server/mcp.js:159` | 300 | 196ms | 18ms | 0.65ms | 11ms |
| `AnalyticsCollector.toPrometheusFormat` | `dist/server/analytics.js:191` | 10,300 | 191ms | 129ms | 0.02ms | 2.2ms |
| `ToolCacheManager.set` | `dist/utils/cache.js:61` | 20,001 | 188ms | 27ms | 0.01ms | 2.4ms |
| `createSessionMcpServer` | `dist/server/mcp.js:112` | 300 | 166ms | 164ms | 0.55ms | 6.6ms |
| `fn callback` | `dist/utils/middleware.js:55` | 6,000 | 159ms | 21ms | 0.03ms | 26ms |
| `promise.then callback` | `dist/utils/retry.js:56` | 10,301 | 156ms | 47ms | 0.02ms | 17ms |
| `use callback` | `bench/run.js:58` | 2,000 | 150ms | 63ms | 0.08ms | 26ms |
| `MiddlewareManager.composeForTool` | `dist/utils/middleware.js:116` | 10,301 | 146ms | 87ms | 0.01ms | 28ms |
| `getBaseZodType` | `dist/registry/tools.js:4` | 60,017 | 132ms | 132ms | 0.00ms | 2.2ms |
| `coerceArguments` | `dist/utils/coercion.js:138` | 22,000 | 126ms | 53ms | 0.01ms | 4.4ms |
| `appWithMiddleware.use callback` | `bench/run.js:50` | 2,000 | 111ms | 12ms | 0.06ms | 26ms |
| `cleanup` | `dist/utils/retry.js:52` | 10,301 | 109ms | 109ms | 0.01ms | 7.5ms |
| `value.map callback` | `dist/utils/cache.js:10` | 120,000 | 94ms | 45ms | 0.00ms | 1.1ms |
| `app.use callback` | `dist/server/hono.js:91` | 600 | 89ms | 71ms | 0.15ms | 7.2ms |
| `use callback` | `bench/run.js:54` | 2,000 | 76ms | 34ms | 0.04ms | 26ms |
| `FileLoggerWriter.getDailyLogPath` | `dist/logging/file-logger.js:48` | 22,606 | 73ms | 73ms | 0.00ms | 5.9ms |
| `smartCoerceValue` | `dist/utils/coercion.js:98` | 64,000 | 73ms | 37ms | 0.00ms | 4.3ms |
| `map callback` | `dist/logging/file-logger.js:10` | 44,907 | 69ms | 69ms | 0.00ms | 6.4ms |
| `escapePrometheus` | `dist/server/analytics.js:321` | 142,100 | 62ms | 62ms | 0.00ms | 0.75ms |
| `MiddlewareManager.getMiddlewaresForTool` | `dist/utils/middleware.js:101` | 10,301 | 46ms | 36ms | 0.00ms | 4.6ms |
| `ContextManager.isInitialized` | `dist/server/context.js:9` | 10,001 | 31ms | 31ms | 0.00ms | 16ms |
| `validateParameterName` | `dist/utils/validation.js:139` | 60,030 | 25ms | 25ms | 0.00ms | 0.16ms |
| `isImageContent` | `dist/utils/media.js:141` | 10,301 | 25ms | 25ms | 0.00ms | 6.6ms |
| `FileLoggerWriter.ensureDir` | `dist/logging/file-logger.js:40` | 22,606 | 24ms | 24ms | 0.00ms | 2.4ms |
| `McpApp.start` | `dist/server/app.js:871` | 1 | 22ms | 2.7ms | 22ms | 22ms |
| `ToolRegistry.get` | `dist/registry/tools.js:110` | 12,001 | 20ms | 20ms | 0.00ms | 5.1ms |
| `app.use callback` | `dist/server/hono.js:19` | 600 | 19ms | 19ms | 0.03ms | 1.6ms |

## Most Called

| Function | Location | Calls | Total | Self | Avg |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `stableSerialize` | `dist/utils/cache.js:5` | 424,004 | 737ms | 268ms | 0.00ms |
| `keys.map callback` | `dist/utils/cache.js:13` | 242,002 | 375ms | 165ms | 0.00ms |
| `escapePrometheus` | `dist/server/analytics.js:321` | 142,100 | 62ms | 62ms | 0.00ms |
| `value.map callback` | `dist/utils/cache.js:10` | 120,000 | 94ms | 45ms | 0.00ms |
| `smartCoerceValue` | `dist/utils/coercion.js:98` | 64,000 | 73ms | 37ms | 0.00ms |
| `validateParameterName` | `dist/utils/validation.js:139` | 60,030 | 25ms | 25ms | 0.00ms |
| `getBaseZodType` | `dist/registry/tools.js:4` | 60,017 | 132ms | 132ms | 0.00ms |
| `map callback` | `dist/logging/file-logger.js:10` | 44,907 | 69ms | 69ms | 0.00ms |
| `coerceNumber` | `dist/utils/coercion.js:5` | 44,000 | 18ms | 18ms | 0.00ms |
| `coerceBoolean` | `dist/utils/coercion.js:23` | 44,000 | 17ms | 17ms | 0.00ms |
| `ToolCacheManager.generateKey` | `dist/utils/cache.js:31` | 42,002 | 357ms | 30ms | 0.01ms |
| `isInputSchemaPropertyConfig` | `dist/registry/tools.js:21` | 40,009 | 9.9ms | 9.9ms | 0.00ms |
| `AnalyticsCollector.recordInvocation` | `dist/server/analytics.js:24` | 32,301 | 274ms | 274ms | 0.01ms |
| `DefaultLogger.shouldLog` | `dist/logging/logger.js:26` | 22,607 | 16ms | 16ms | 0.00ms |
| `DefaultLogger.write` | `dist/logging/logger.js:29` | 22,607 | 7.76s | 95ms | 0.34ms |
| `formatLogLine` | `dist/logging/file-logger.js:4` | 22,606 | 275ms | 206ms | 0.01ms |
| `FileLoggerWriter.ensureDir` | `dist/logging/file-logger.js:40` | 22,606 | 24ms | 24ms | 0.00ms |
| `FileLoggerWriter.getDailyLogPath` | `dist/logging/file-logger.js:48` | 22,606 | 73ms | 73ms | 0.00ms |
| `FileLoggerWriter.write` | `dist/logging/file-logger.js:56` | 22,606 | 7.65s | 7.28s | 0.34ms |
| `DefaultLogger.info` | `dist/logging/logger.js:47` | 22,606 | 7.81s | 44ms | 0.35ms |
| `ToolCacheManager.get` | `dist/utils/cache.js:40` | 22,001 | 247ms | 51ms | 0.01ms |
| `coerceArguments` | `dist/utils/coercion.js:138` | 22,000 | 126ms | 53ms | 0.01ms |
| `normalizeInputSchema` | `dist/registry/tools.js:28` | 20,021 | 363ms | 195ms | 0.02ms |
| `ToolCacheManager.set` | `dist/utils/cache.js:61` | 20,001 | 188ms | 27ms | 0.01ms |
| `coerceArray` | `dist/utils/coercion.js:64` | 20,000 | 15ms | 15ms | 0.00ms |
| `ConcurrencyQueue.constructor` | `dist/utils/queue.js:16` | 20,000 | 5.0ms | 5.0ms | 0.00ms |
| `ConcurrencyQueue.acquire` | `dist/utils/queue.js:34` | 20,000 | 6.5ms | 6.5ms | 0.00ms |
| `anonymous@41:20` | `dist/utils/queue.js:41` | 20,000 | 15ms | 7.9ms | 0.00ms |
| `ConcurrencyQueue.release` | `dist/utils/queue.js:98` | 20,000 | 7.1ms | 7.1ms | 0.00ms |
| `dispatch` | `dist/utils/middleware.js:42` | 16,301 | 1.68s | 129ms | 0.10ms |
| `ToolRegistry.get` | `dist/registry/tools.js:110` | 12,001 | 20ms | 20ms | 0.00ms |
| `McpApp.callTool` | `dist/server/app.js:200` | 12,001 | 13.30s | 1.61s | 1.1ms |
| `ContextManager.getContext` | `dist/server/context.js:45` | 10,301 | 8.6ms | 8.6ms | 0.00ms |
| `createProgressReporter` | `dist/utils/progress.js:9` | 10,301 | 18ms | 18ms | 0.00ms |
| `composeMiddleware` | `dist/utils/middleware.js:39` | 10,301 | 14ms | 14ms | 0.00ms |
| `anonymous@40:12` | `dist/utils/middleware.js:40` | 10,301 | 1.59s | 46ms | 0.15ms |
| `MiddlewareManager.getMiddlewaresForTool` | `dist/utils/middleware.js:101` | 10,301 | 46ms | 36ms | 0.00ms |
| `MiddlewareManager.composeForTool` | `dist/utils/middleware.js:116` | 10,301 | 146ms | 87ms | 0.01ms |
| `isImageContent` | `dist/utils/media.js:141` | 10,301 | 25ms | 25ms | 0.00ms |
| `raceWithSignal` | `dist/utils/retry.js:37` | 10,301 | 373ms | 142ms | 0.04ms |
| `anonymous@43:24` | `dist/utils/retry.js:43` | 10,301 | 231ms | 231ms | 0.02ms |
| `cleanup` | `dist/utils/retry.js:52` | 10,301 | 109ms | 109ms | 0.01ms |
| `promise.then callback` | `dist/utils/retry.js:56` | 10,301 | 156ms | 47ms | 0.02ms |
| `executeWithRetry` | `dist/utils/retry.js:75` | 10,301 | 3.28s | 162ms | 0.32ms |
| `normalizeToolResult` | `dist/server/mcp.js:10` | 10,301 | 232ms | 208ms | 0.02ms |
| `McpApp.resolveQueueConfig` | `dist/server/app.js:484` | 10,301 | 16ms | 16ms | 0.00ms |
| `AnalyticsCollector.toPrometheusFormat` | `dist/server/analytics.js:191` | 10,300 | 191ms | 129ms | 0.02ms |
| `ToolCacheManager.getStats` | `dist/utils/cache.js:107` | 10,300 | 2.9ms | 2.9ms | 0.00ms |
| `ContextManager.isInitialized` | `dist/server/context.js:9` | 10,001 | 31ms | 31ms | 0.00ms |
| `middlewareManager.composeForTool callback` | `dist/server/app.js:384` | 10,001 | 1.36s | 1.35s | 0.14ms |

## Call Relationships

| Caller | Callee | Calls |
| :--- | :--- | :---: |
| `stableSerialize` | `keys.map callback` | x242,002 |
| `keys.map callback` | `stableSerialize` | x242,002 |
| `AnalyticsCollector.toPrometheusFormat` | `escapePrometheus` | x142,100 |
| `stableSerialize` | `value.map callback` | x120,000 |
| `value.map callback` | `stableSerialize` | x120,000 |
| `coerceArguments` | `smartCoerceValue` | x64,000 |
| `normalizeInputSchema` | `validateParameterName` | x60,030 |
| `normalizeInputSchema` | `getBaseZodType` | x60,017 |
| `formatLogLine` | `map callback` | x44,907 |
| `ToolCacheManager.generateKey` | `stableSerialize` | x42,002 |
