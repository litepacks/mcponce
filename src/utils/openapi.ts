import fs from 'node:fs';
import { z } from 'zod';
import { sanitizeToolName } from './validation.js';
import type { ToolDefinition, ToolMiddlewareHandler, ToolCacheConfig } from '../types.js';

export interface OpenApiOperation {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie' | 'body';
    required?: boolean;
    description?: string;
    schema?: any;
    type?: string;
    default?: any;
  }>;
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: any }>;
  };
  responses?: Record<string, any>;
}

export interface OpenApiOptions {
  /**
   * Overrides the base URL defined in the OpenAPI specification.
   */
  baseUrl?: string;
  /**
   * Optional prefix prepended to all generated tool names.
   * e.g. prefix: "petstore" -> "petstore_get_pet"
   */
  prefix?: string;
  /**
   * Static headers or dynamic header factory for outbound HTTP requests.
   * e.g. { 'Authorization': 'Bearer <token>' }
   */
  headers?:
    | Record<string, string>
    | ((context: { operation: OpenApiOperation; args: any }) => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Filters which operations to include by operationId, path, or predicate.
   */
  include?: string[] | RegExp | ((operation: OpenApiOperation) => boolean);
  /**
   * Filters which operations to exclude.
   */
  exclude?: string[] | RegExp | ((operation: OpenApiOperation) => boolean);
  /**
   * Filter endpoints to only those containing any of the specified OpenAPI tags.
   */
  tags?: string[];
  /**
   * Custom tool name generator function.
   * By default, uses sanitized operationId or "${method}_${path}".
   */
  toolNameGenerator?: (operation: OpenApiOperation) => string;
  /**
   * Custom handler to transform the raw response before returning to the MCP client.
   */
  transformResponse?: (response: { status: number; statusText: string; headers: Headers; data: any }) => any;
  /**
   * If true, enables in-memory response caching for GET endpoints.
   */
  cache?: boolean | ToolCacheConfig;
  /**
   * Concurrency/mutex setting for generated tools.
   */
  sequential?: boolean | string;
  /**
   * Timeout in milliseconds for outbound HTTP requests.
   */
  timeoutMs?: number;
  /**
   * Middleware handlers attached to all generated OpenAPI tools.
   */
  middleware?: ToolMiddlewareHandler[];
}

/**
 * Loads an OpenAPI specification from an object, raw JSON string, URL, or local file path.
 */
export async function loadOpenApiSpec(spec: Record<string, any> | string): Promise<Record<string, any>> {
  if (typeof spec === 'object' && spec !== null) {
    return spec;
  }

  if (typeof spec === 'string') {
    const trimmed = spec.trim();

    // 1. URL
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const response = await fetch(trimmed);
      if (!response.ok) {
        throw new Error(`Failed to fetch OpenAPI spec from ${trimmed}: HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    }

    // 2. Inline JSON string
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch (err: any) {
        throw new Error(`Failed to parse inline OpenAPI JSON: ${err.message}`);
      }
    }

    // 3. Local file path
    if (fs.existsSync(trimmed)) {
      const content = fs.readFileSync(trimmed, 'utf-8');
      try {
        return JSON.parse(content);
      } catch (err: any) {
        throw new Error(`Failed to parse OpenAPI JSON file at "${trimmed}": ${err.message}`);
      }
    }
  }

  throw new Error(`Invalid OpenAPI specification input. Expected an object, JSON string, file path, or URL.`);
}

/**
 * Resolves the primary base URL from an OpenAPI v3 or Swagger v2 specification.
 */
export function resolveBaseUrl(spec: Record<string, any>, overrideUrl?: string): string {
  if (overrideUrl) {
    return overrideUrl.replace(/\/+$/, '');
  }

  // OpenAPI 3.x
  if (Array.isArray(spec.servers) && spec.servers.length > 0 && spec.servers[0].url) {
    const serverUrl = spec.servers[0].url;
    if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
      return serverUrl.replace(/\/+$/, '');
    }
  }

  // Swagger 2.0
  if (spec.host) {
    const scheme = (Array.isArray(spec.schemes) && spec.schemes[0]) || 'https';
    const basePath = spec.basePath || '';
    return `${scheme}://${spec.host}${basePath}`.replace(/\/+$/, '');
  }

  return 'http://localhost';
}

export function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }

  const type = schema.type;

  if (type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    return z.string();
  }

  if (type === 'number' || type === 'integer') {
    return z.number();
  }

  if (type === 'boolean') {
    return z.boolean();
  }

  if (type === 'array') {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    return z.array(itemSchema);
  }

  if (type === 'object') {
    if (schema.properties && typeof schema.properties === 'object') {
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        let fieldZod = jsonSchemaToZod(propSchema);
        if (!required.has(key)) {
          fieldZod = fieldZod.optional();
        }
        shape[key] = fieldZod;
      }
      return z.object(shape);
    }
    return z.record(z.any());
  }

  return z.any();
}

/**
 * Generates an array of executable McpTool definitions from an OpenAPI or Swagger specification.
 */
export async function createOpenApiTools(
  specInput: Record<string, any> | string,
  options: OpenApiOptions = {}
): Promise<ToolDefinition[]> {
  const spec = await loadOpenApiSpec(specInput);
  const baseUrl = resolveBaseUrl(spec, options.baseUrl);
  const tools: ToolDefinition[] = [];

  const paths = spec.paths || {};
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const commonParameters = Array.isArray((pathItem as any).parameters) ? (pathItem as any).parameters : [];

    for (const method of httpMethods) {
      const operationObj = (pathItem as any)[method];
      if (!operationObj || typeof operationObj !== 'object') continue;

      const operation: OpenApiOperation = {
        path: pathKey,
        method,
        operationId: operationObj.operationId,
        summary: operationObj.summary,
        description: operationObj.description,
        tags: operationObj.tags || [],
        parameters: [...commonParameters, ...(Array.isArray(operationObj.parameters) ? operationObj.parameters : [])],
        requestBody: operationObj.requestBody,
        responses: operationObj.responses
      };

      // Apply tags filter
      if (options.tags && options.tags.length > 0) {
        const hasMatchingTag = operation.tags?.some((t) => options.tags!.includes(t));
        if (!hasMatchingTag) continue;
      }

      // Apply include filter
      if (options.include) {
        if (typeof options.include === 'function') {
          if (!options.include(operation)) continue;
        } else if (Array.isArray(options.include)) {
          const matched =
            (operation.operationId && options.include.includes(operation.operationId)) ||
            options.include.includes(operation.path);
          if (!matched) continue;
        } else if (options.include instanceof RegExp) {
          const target = operation.operationId || `${method}:${operation.path}`;
          if (!options.include.test(target)) continue;
        }
      }

      // Apply exclude filter
      if (options.exclude) {
        if (typeof options.exclude === 'function') {
          if (options.exclude(operation)) continue;
        } else if (Array.isArray(options.exclude)) {
          const matched =
            (operation.operationId && options.exclude.includes(operation.operationId)) ||
            options.exclude.includes(operation.path);
          if (matched) continue;
        } else if (options.exclude instanceof RegExp) {
          const target = operation.operationId || `${method}:${operation.path}`;
          if (options.exclude.test(target)) continue;
        }
      }

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

      // Determine Tool Name
      let toolName: string;
      if (options.toolNameGenerator) {
        toolName = options.toolNameGenerator(operation);
      } else if (operation.operationId) {
        toolName = sanitizeToolName(toSnakeCase(operation.operationId));
      } else {
        const pathPart = operation.path
          .replace(/\{([^}]+)\}/g, 'by_$1')
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        toolName = sanitizeToolName(toSnakeCase(`${method}_${pathPart}`));
      }

      if (options.prefix) {
        toolName = sanitizeToolName(`${toSnakeCase(options.prefix)}_${toolName}`);
      }

      // Determine description
      const description = operation.summary || operation.description || `${method.toUpperCase()} ${operation.path}`;

      // Build Zod input schema from parameters and requestBody
      const zodShape: Record<string, z.ZodTypeAny> = {};
      const pathParams = new Set<string>();
      const queryParams = new Set<string>();
      const headerParams = new Set<string>();

      for (const p of operation.parameters || []) {
        if (!p.name) continue;
        const paramName = p.name;
        if (p.in === 'path') pathParams.add(paramName);
        if (p.in === 'query') queryParams.add(paramName);
        if (p.in === 'header') headerParams.add(paramName);

        const schema = p.schema || { type: p.type || 'string' };
        let fieldZod = jsonSchemaToZod(schema);
        if (!p.required) {
          fieldZod = fieldZod.optional();
        }
        zodShape[paramName] = fieldZod;
      }

      // Handle requestBody (OpenAPI 3)
      let hasRequestBody = false;
      const jsonContent = operation.requestBody?.content?.['application/json'];
      if (jsonContent && jsonContent.schema) {
        hasRequestBody = true;
        const bodySchema = jsonContent.schema;
        if (bodySchema.type === 'object' && bodySchema.properties && typeof bodySchema.properties === 'object') {
          const requiredProps = new Set(Array.isArray(bodySchema.required) ? bodySchema.required : []);
          for (const [propKey, propSchema] of Object.entries(bodySchema.properties)) {
            // If collision with path/query param, don't overwrite
            if (zodShape[propKey]) continue;
            let fieldZod = jsonSchemaToZod(propSchema);
            if (!requiredProps.has(propKey)) {
              fieldZod = fieldZod.optional();
            }
            zodShape[propKey] = fieldZod;
          }
        } else {
          zodShape['body'] = jsonSchemaToZod(bodySchema);
        }
      }

      // Handle body parameter (Swagger 2)
      const swaggerBodyParam = operation.parameters?.find((p) => p.in === 'body');
      if (swaggerBodyParam && swaggerBodyParam.schema) {
        hasRequestBody = true;
        zodShape['body'] = jsonSchemaToZod(swaggerBodyParam.schema);
      }

      const inputSchema = zodShape;

      // Create Tool Definition
      const toolDef: ToolDefinition = {
        name: toolName,
        description,
        inputSchema,
        timeoutMs: options.timeoutMs,
        sequential: options.sequential,
        cache: method === 'get' && options.cache ? options.cache : undefined,
        middleware: options.middleware,
        handler: async (args: any, context: any) => {
          const signal = context?.signal;

          // 1. Interpolate Path Parameters
          let resolvedPath = operation.path;
          for (const param of pathParams) {
            if (args[param] !== undefined) {
              resolvedPath = resolvedPath.replace(
                new RegExp(`\\{${param}\\}`, 'g'),
                encodeURIComponent(String(args[param]))
              );
            }
          }

          // 2. Construct Query String
          const query = new URLSearchParams();
          for (const param of queryParams) {
            if (args[param] !== undefined && args[param] !== null) {
              if (Array.isArray(args[param])) {
                for (const item of args[param]) {
                  query.append(param, String(item));
                }
              } else {
                query.append(param, String(args[param]));
              }
            }
          }

          const queryString = query.toString();
          const fullUrl = `${baseUrl}${resolvedPath}${queryString ? `?${queryString}` : ''}`;

          // 3. Prepare Headers
          const reqHeaders: Record<string, string> = {
            'Accept': 'application/json, text/plain, */*'
          };

          if (options.headers) {
            const extra =
              typeof options.headers === 'function'
                ? await options.headers({ operation, args })
                : options.headers;
            Object.assign(reqHeaders, extra);
          }

          for (const param of headerParams) {
            if (args[param] !== undefined) {
              reqHeaders[param] = String(args[param]);
            }
          }

          // 4. Prepare Body
          let bodyPayload: string | undefined;
          if (['post', 'put', 'patch', 'delete'].includes(method)) {
            if (args.body !== undefined) {
              bodyPayload = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
              reqHeaders['Content-Type'] = 'application/json';
            } else if (hasRequestBody) {
              // Collect non-path, non-query, non-header args into body object
              const bodyObj: Record<string, any> = {};
              for (const [key, val] of Object.entries(args)) {
                if (!pathParams.has(key) && !queryParams.has(key) && !headerParams.has(key)) {
                  bodyObj[key] = val;
                }
              }
              if (Object.keys(bodyObj).length > 0) {
                bodyPayload = JSON.stringify(bodyObj);
                reqHeaders['Content-Type'] = 'application/json';
              }
            }
          }

          // 5. Execute HTTP Request
          const response = await fetch(fullUrl, {
            method: method.toUpperCase(),
            headers: reqHeaders,
            body: bodyPayload,
            signal
          });

          // 6. Parse Output
          const contentType = response.headers.get('content-type') || '';
          let data: any;
          if (contentType.includes('application/json')) {
            try {
              data = await response.json();
            } catch {
              data = await response.text();
            }
          } else {
            data = await response.text();
          }

          if (options.transformResponse) {
            return options.transformResponse({
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              data
            });
          }

          if (!response.ok) {
            return {
              isError: true,
              status: response.status,
              statusText: response.statusText,
              data
            };
          }

          return data;
        }
      };

      tools.push(toolDef);
    }
  }

  return tools;
}
