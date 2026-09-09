import type {
  MiddlewareFilter,
  NextFunction,
  ToolMiddlewareContext,
  ToolMiddlewareHandler,
  ConfiguredMiddleware
} from '../types.js';

/**
 * Checks whether a given tool name matches a middleware filter.
 * Supports:
 * - undefined / '*': matches all tools
 * - string exact match: 'my_tool'
 * - string wildcard: 'db_*', '*_query'
 * - RegExp: /^admin_/
 * - Array of strings or wildcards: ['tool_a', 'db_*']
 */
export function matchesFilter(
  filter: MiddlewareFilter | undefined,
  toolName: string
): boolean {
  if (!filter || filter === '*') {
    return true;
  }

  if (typeof filter === 'string') {
    if (filter === toolName) {
      return true;
    }
    if (filter.includes('*')) {
      const regexStr = '^' + filter.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      return new RegExp(regexStr).test(toolName);
    }
    return false;
  }

  if (filter instanceof RegExp) {
    return filter.test(toolName);
  }

  if (Array.isArray(filter)) {
    return filter.some((item) => matchesFilter(item, toolName));
  }

  return false;
}

/**
 * Composes a list of middleware handlers with a final tool handler into an onion pipeline.
 * Follows the standard Koa/Hono composition pattern:
 * - Guarantees sequential execution of middlewares
 * - Prevents multiple next() calls from a single middleware
 * - Propagates returns and catches exceptions cleanly
 */
export function composeMiddleware<TContext = unknown>(
  middlewares: ToolMiddlewareHandler<TContext>[],
  finalHandler: (ctx: ToolMiddlewareContext<TContext>) => Promise<any>
): (ctx: ToolMiddlewareContext<TContext>) => Promise<any> {
  return function (ctx: ToolMiddlewareContext<TContext>): Promise<any> {
    let index = -1;

    function dispatch(i: number): Promise<any> {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      if (i === middlewares.length) {
        return Promise.resolve(finalHandler(ctx));
      }

      const fn = middlewares[i];
      if (!fn) {
        return Promise.resolve();
      }

      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return dispatch(0);
  };
}

export class MiddlewareManager<TContext = unknown> {
  private entries: Array<{
    filter?: MiddlewareFilter;
    handler: ToolMiddlewareHandler<TContext>;
  }> = [];

  constructor(
    initialMiddlewares?: (ToolMiddlewareHandler<TContext> | ConfiguredMiddleware<TContext>)[]
  ) {
    if (initialMiddlewares && Array.isArray(initialMiddlewares)) {
      for (const item of initialMiddlewares) {
        if (typeof item === 'function') {
          this.use(item);
        } else if (item && typeof item === 'object' && typeof item.handler === 'function') {
          if (item.filter !== undefined) {
            this.use(item.filter, item.handler);
          } else {
            this.use(item.handler);
          }
        }
      }
    }
  }

  /**
   * Registers a global tool middleware that intercepts all tool executions.
   */
  use(handler: ToolMiddlewareHandler<TContext>): this;
  /**
   * Registers a filtered tool middleware that intercepts matching tools.
   */
  use(filter: MiddlewareFilter, handler: ToolMiddlewareHandler<TContext>): this;
  use(
    filterOrHandler: MiddlewareFilter | ToolMiddlewareHandler<TContext>,
    maybeHandler?: ToolMiddlewareHandler<TContext>
  ): this {
    if (typeof filterOrHandler === 'function') {
      this.entries.push({ handler: filterOrHandler as ToolMiddlewareHandler<TContext> });
    } else if (maybeHandler && typeof maybeHandler === 'function') {
      this.entries.push({
        filter: filterOrHandler as MiddlewareFilter,
        handler: maybeHandler
      });
    } else {
      throw new Error('Middleware handler must be a function');
    }
    return this;
  }

  /**
   * Retrieves all matching middlewares for a given tool name, appending any tool-level middlewares.
   */
  getMiddlewaresForTool(
    toolName: string,
    toolSpecificMiddleware?: ToolMiddlewareHandler<TContext>[]
  ): ToolMiddlewareHandler<TContext>[] {
    const matched: ToolMiddlewareHandler<TContext>[] = [];

    for (const entry of this.entries) {
      if (matchesFilter(entry.filter, toolName)) {
        matched.push(entry.handler);
      }
    }

    if (toolSpecificMiddleware && toolSpecificMiddleware.length > 0) {
      matched.push(...toolSpecificMiddleware);
    }

    return matched;
  }

  /**
   * Composes all matching middlewares for a tool and wraps the final handler into an executable pipeline.
   */
  composeForTool(
    toolName: string,
    finalHandler: (ctx: ToolMiddlewareContext<TContext>) => Promise<any>,
    toolSpecificMiddleware?: ToolMiddlewareHandler<TContext>[]
  ): (ctx: ToolMiddlewareContext<TContext>) => Promise<any> {
    const middlewares = this.getMiddlewaresForTool(toolName, toolSpecificMiddleware);
    return composeMiddleware(middlewares, finalHandler);
  }

  /**
   * Returns the count of registered middlewares.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Clears all registered middlewares.
   */
  clear(): void {
    this.entries = [];
  }
}
