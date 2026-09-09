import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rootToPath,
  isPathInWorkspace,
  findWorkspaceRoot,
  resolveWorkspacePath,
  createOpenApiTools,
  createMcpServer
} from '../src/index.js';

describe('MCP Roots Utilities & OpenAPI Tool Auto-Generation (Item #6)', () => {
  describe('Workspace Roots Utilities', () => {
    const mockRoots = [
      { uri: 'file:///Users/dev/my-project', name: 'main' },
      { uri: 'file:///Users/dev/shared-packages', name: 'shared' }
    ];

    it('converts file:// URIs and standard paths via rootToPath', () => {
      const p1 = rootToPath('file:///Users/dev/my-project');
      expect(p1).toBe('/Users/dev/my-project');

      const p2 = rootToPath({ uri: 'file:///Users/dev/shared-packages', name: 'shared' });
      expect(p2).toBe('/Users/dev/shared-packages');

      const p3 = rootToPath('/tmp/regular-path');
      expect(p3).toBe('/tmp/regular-path');
    });

    it('validates whether a path is safely inside workspace roots', () => {
      expect(isPathInWorkspace(mockRoots, '/Users/dev/my-project/src/index.ts')).toBe(true);
      expect(isPathInWorkspace(mockRoots, '/Users/dev/shared-packages/utils.js')).toBe(true);
      expect(isPathInWorkspace(mockRoots, '/Users/dev/my-project')).toBe(true);

      // Traversal or outside paths
      expect(isPathInWorkspace(mockRoots, '/Users/dev/other-project/secret.key')).toBe(false);
      expect(isPathInWorkspace(mockRoots, '/etc/passwd')).toBe(false);
      expect(isPathInWorkspace(mockRoots, '/Users/dev/my-project/../../etc/passwd')).toBe(false);
    });

    it('finds which workspace root contains a file path', () => {
      const root1 = findWorkspaceRoot(mockRoots, '/Users/dev/my-project/package.json');
      expect(root1?.name).toBe('main');

      const root2 = findWorkspaceRoot(mockRoots, '/Users/dev/shared-packages/tsconfig.json');
      expect(root2?.name).toBe('shared');

      const rootNone = findWorkspaceRoot(mockRoots, '/var/log/syslog');
      expect(rootNone).toBeUndefined();
    });

    it('resolves relative workspace paths and blocks path traversal', () => {
      const resolved = resolveWorkspacePath(mockRoots, 'src/components/App.tsx');
      expect(resolved).toBe('/Users/dev/my-project/src/components/App.tsx');

      expect(() => {
        resolveWorkspacePath(mockRoots, '../../secret/keys.json');
      }).toThrow(/Path traversal denied/);
    });
  });

  describe('OpenAPI & Swagger Tool Auto-Generation', () => {
    const sampleOpenApi3 = {
      openapi: '3.0.0',
      info: { title: 'Store API', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List users with pagination',
            tags: ['users'],
            parameters: [
              { name: 'role', in: 'query', schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }
            ]
          },
          post: {
            operationId: 'createUser',
            summary: 'Create a new user',
            tags: ['users'],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'name'],
                    properties: {
                      email: { type: 'string' },
                      name: { type: 'string' },
                      age: { type: 'integer' }
                    }
                  }
                }
              }
            }
          }
        },
        '/users/{userId}': {
          get: {
            operationId: 'getUserById',
            summary: 'Get user details by ID',
            tags: ['users'],
            parameters: [
              { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }
            ]
          },
          delete: {
            operationId: 'deleteUser',
            summary: 'Delete user',
            tags: ['admin'],
            parameters: [
              { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }
            ]
          }
        }
      }
    };

    it('generates tools with correct names, schemas, and descriptions from OpenAPI 3 spec', async () => {
      const tools = await createOpenApiTools(sampleOpenApi3);
      expect(tools).toHaveLength(4);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('list_users');
      expect(toolNames).toContain('create_user');
      expect(toolNames).toContain('get_user_by_id');
      expect(toolNames).toContain('delete_user');

      const getUserTool = tools.find((t) => t.name === 'get_user_by_id')!;
      expect(getUserTool.description).toBe('Get user details by ID');
      expect(getUserTool.inputSchema).toBeDefined();

      const createTool = tools.find((t) => t.name === 'create_user')!;
      expect(createTool.inputSchema).toHaveProperty('email');
      expect(createTool.inputSchema).toHaveProperty('name');
    });

    it('supports Swagger 2.0 specs with host and basePath', async () => {
      const swagger2 = {
        swagger: '2.0',
        host: 'api.legacy.com',
        basePath: '/api/v2',
        schemes: ['https'],
        paths: {
          '/items': {
            get: {
              operationId: 'getItems',
              summary: 'Retrieve items',
              parameters: [
                { name: 'category', in: 'query', type: 'string' }
              ]
            }
          }
        }
      };

      const tools = await createOpenApiTools(swagger2);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('get_items');
      expect(tools[0].description).toBe('Retrieve items');
    });

    it('filters endpoints using tags, include, and exclude options', async () => {
      // Filter by tag
      const adminOnly = await createOpenApiTools(sampleOpenApi3, {
        tags: ['admin']
      });
      expect(adminOnly).toHaveLength(1);
      expect(adminOnly[0].name).toBe('delete_user');

      // Filter by include
      const included = await createOpenApiTools(sampleOpenApi3, {
        include: ['listUsers', 'getUserById']
      });
      expect(included.map((t) => t.name)).toEqual(['list_users', 'get_user_by_id']);

      // Filter by exclude
      const excluded = await createOpenApiTools(sampleOpenApi3, {
        exclude: /delete/i
      });
      expect(excluded.map((t) => t.name)).not.toContain('delete_user');
    });

    it('executes API call with path, query, headers, and request body via fetch', async () => {
      let capturedUrl = '';
      let capturedOptions: any = null;

      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async (url: any, opts: any) => {
        capturedUrl = url.toString();
        capturedOptions = opts;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ id: 'usr-42', name: 'Alice', email: 'alice@example.com' })
        };
      });

      try {
        const app = createMcpServer('openapi-test-app');
        await app.fromOpenApi(sampleOpenApi3, {
          headers: {
            'X-API-Key': 'secret-123'
          }
        });

        // 1. Test GET with path parameter
        const getRes = await app.callTool('get_user_by_id', { userId: 'usr-999' });
        expect(capturedUrl).toBe('https://api.example.com/v1/users/usr-999');
        expect(capturedOptions.method).toBe('GET');
        expect(capturedOptions.headers['X-API-Key']).toBe('secret-123');
        expect(getRes.data).toEqual({ id: 'usr-42', name: 'Alice', email: 'alice@example.com' });

        // 2. Test GET with query parameters
        await app.callTool('list_users', { role: 'developer', limit: 10 });
        expect(capturedUrl).toBe('https://api.example.com/v1/users?role=developer&limit=10');

        // 3. Test POST with request body
        await app.callTool('create_user', { name: 'Bob', email: 'bob@example.com' });
        expect(capturedUrl).toBe('https://api.example.com/v1/users');
        expect(capturedOptions.method).toBe('POST');
        expect(JSON.parse(capturedOptions.body)).toEqual({ name: 'Bob', email: 'bob@example.com' });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('supports transformResponse and handles HTTP errors gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: 'User does not exist' })
        };
      });

      try {
        const app = createMcpServer('openapi-error-app');
        await app.fromOpenApi(sampleOpenApi3, {
          transformResponse: ({ status, data }) => ({
            customStatus: status,
            payload: data
          })
        });

        const res = await app.callTool('get_user_by_id', { userId: 'usr-nonexistent' });
        expect(res.data).toEqual({
          customStatus: 404,
          payload: { message: 'User does not exist' }
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('loads OpenAPI specs from raw JSON strings and local files', async () => {
      // 1. JSON string
      const jsonString = JSON.stringify(sampleOpenApi3);
      const toolsFromString = await createOpenApiTools(jsonString);
      expect(toolsFromString).toHaveLength(4);

      // 2. Local file
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tempPath = path.join(os.tmpdir(), `test-openapi-${Date.now()}.json`);
      fs.writeFileSync(tempPath, jsonString, 'utf-8');

      try {
        const toolsFromFile = await createOpenApiTools(tempPath);
        expect(toolsFromFile).toHaveLength(4);
      } finally {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    });

    it('tests loadOpenApiSpec from URL, Swagger 2.0 baseUrl, and error cases', async () => {
      const { resolveBaseUrl, jsonSchemaToZod } = await import('../src/utils/openapi.js');

      // Test jsonSchemaToZod fallbacks
      expect(jsonSchemaToZod(null).safeParse('anything').success).toBe(true);
      expect(jsonSchemaToZod({ type: 'unknown-primitive' }).safeParse(123).success).toBe(true);

      // 1. Swagger 2.0 baseUrl resolution
      const swagger2 = {
        swagger: '2.0',
        host: 'api.swagger.io',
        basePath: '/v2',
        schemes: ['https']
      };
      expect(resolveBaseUrl(swagger2)).toBe('https://api.swagger.io/v2');

      // Fallback
      expect(resolveBaseUrl({})).toBe('http://localhost');

      // 2. Fetch from URL success & error
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => sampleOpenApi3
      } as any);

      const toolsFromUrl = await createOpenApiTools('https://example.com/openapi.json');
      expect(toolsFromUrl).toHaveLength(4);

      // URL failure
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      } as any);

      await expect(createOpenApiTools('https://example.com/404.json')).rejects.toThrow('HTTP 404');
      globalThis.fetch = originalFetch;

      // 3. Invalid inputs
      await expect(createOpenApiTools('{invalid json')).rejects.toThrow(/Failed to parse/);
      await expect(createOpenApiTools(12345 as any)).rejects.toThrow(/Invalid OpenAPI specification/);

      // 4. Corrupt local file
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const corruptPath = path.join(os.tmpdir(), `corrupt-openapi-${Date.now()}.json`);
      fs.writeFileSync(corruptPath, '{ corrupt json', 'utf-8');
      try {
        await expect(createOpenApiTools(corruptPath)).rejects.toThrow(/Failed to parse OpenAPI JSON file/);
      } finally {
        if (fs.existsSync(corruptPath)) fs.unlinkSync(corruptPath);
      }

      // 5. Override URL
      expect(resolveBaseUrl(sampleOpenApi3, 'https://override.example.com/api///')).toBe('https://override.example.com/api');
    });

    it('covers all filtering, naming, schema types, and handler execution branches', async () => {
      const advancedSpec = {
        openapi: '3.0.0',
        info: { title: 'Advanced API', version: '1.0.0' },
        servers: [{ url: 'https://api.advanced.com' }],
        paths: {
          '/items': {
            get: {
              summary: 'No operation ID item list',
              parameters: [
                { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
                { name: 'active', in: 'query', schema: { type: 'boolean' } },
                { name: 'X-Org', in: 'header', schema: { type: 'string' } }
              ]
            },
            post: {
              operationId: 'createItem',
              summary: 'Create item with enum and record',
              parameters: [
                { in: 'body', schema: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'published'] }, metadata: { type: 'object' } } } }
              ]
            },
            delete: {
              operationId: 'deleteItem',
              summary: 'Delete item'
            },
            put: {
              operationId: 'updateRawItem',
              summary: 'Update item with raw string schema and any schema',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'string' }
                  }
                }
              },
              parameters: [
                { name: 'untyped', in: 'query', schema: null as any }
              ]
            }
          }
        }
      };

      // 1. Tool name generator & prefix & fallbacks
      const tools1 = await createOpenApiTools(advancedSpec, {
        prefix: 'v1',
        toolNameGenerator: (op) => `custom_${op.method}_${op.path.replace(/\//g, '')}`
      });
      expect(tools1[0].name).toBe('v1_custom_get_items');

      // 2. Fallback when operationId is missing
      const toolsDefaultNaming = await createOpenApiTools(advancedSpec);
      expect(toolsDefaultNaming.some(t => t.name.includes('get_items'))).toBe(true);

      // 3. Include / Exclude with functions, arrays, and RegExps
      const toolsIncludeFn = await createOpenApiTools(advancedSpec, {
        include: (op) => op.method === 'post'
      });
      expect(toolsIncludeFn).toHaveLength(1);
      expect(toolsIncludeFn[0].name).toBe('create_item');

      const toolsIncludeRegex = await createOpenApiTools(advancedSpec, {
        include: /deleteItem/
      });
      expect(toolsIncludeRegex).toHaveLength(1);
      expect(toolsIncludeRegex[0].name).toBe('delete_item');

      const toolsExcludeFn = await createOpenApiTools(advancedSpec, {
        exclude: (op) => op.method === 'delete'
      });
      expect(toolsExcludeFn.some(t => t.name === 'delete_item')).toBe(false);

      const toolsExcludeArray = await createOpenApiTools(advancedSpec, {
        exclude: ['deleteItem']
      });
      expect(toolsExcludeArray.some(t => t.name === 'delete_item')).toBe(false);

      const toolsExcludeRegex = await createOpenApiTools(advancedSpec, {
        exclude: /createItem/
      });
      expect(toolsExcludeRegex.some(t => t.name === 'create_item')).toBe(false);

      // 4. Test Handler execution: query array, header parameters, headers function, non-OK response, non-JSON response, invalid JSON response
      const originalFetch = globalThis.fetch;
      try {
        let lastFetchUrl = '';
        let lastFetchHeaders: any = {};
        let lastFetchBody: any = undefined;

        // Mock 1: Non-OK response
        globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
          lastFetchUrl = url;
          lastFetchHeaders = init.headers;
          lastFetchBody = init.body;
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Error',
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ error: 'database down' }),
            text: async () => '{"error": "database down"}'
          };
        });

        const app = createMcpServer({ name: 'openapi-test-app', registerInCentral: false });
        const tools = await createOpenApiTools(advancedSpec, {
          headers: async ({ operation, args }) => ({ 'X-Dynamic': 'dynamic-value' })
        });
        for (const t of tools) app.tool(t);

        // Call GET with array query and header
        const res1 = await app.callTool('get_items', {
          tags: ['tech', 'news'],
          active: true,
          'X-Org': 'org-123'
        });
        expect(res1.data.isError).toBe(true);
        expect(res1.data.status).toBe(500);
        expect(lastFetchUrl).toContain('tags=tech&tags=news');
        expect(lastFetchUrl).toContain('active=true');
        expect(lastFetchHeaders['X-Org']).toBe('org-123');
        expect(lastFetchHeaders['X-Dynamic']).toBe('dynamic-value');

        // Mock 2: Non-JSON content type response
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/plain' }),
          text: async () => 'Plain text body response'
        });

        const res2 = await app.callTool('get_items', {});
        expect(res2.text).toBe('Plain text body response');

        // Mock 3: JSON content-type but invalid JSON body -> fallback to text
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => { throw new Error('Invalid JSON'); },
          text: async () => 'Not a valid JSON string'
        });

        const res3 = await app.callTool('get_items', {});
        expect(res3.text).toBe('Not a valid JSON string');

        // Mock 4: POST with body object
        globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
          return {
            ok: true,
            status: 201,
            statusText: 'Created',
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ id: 'new-item-1', bodyReceived: JSON.parse(init.body) }),
            text: async () => ''
          };
        });

        const res4 = await app.callTool('create_item', {
          body: { status: 'draft', metadata: { foo: 'bar' } }
        });
        expect(res4.data.id).toBe('new-item-1');
        expect(res4.data.bodyReceived.status).toBe('draft');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
