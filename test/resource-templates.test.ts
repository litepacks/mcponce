import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  McpApp,
  ResourceRegistry,
  normalizeResourceResult
} from '../src/index.js';
import { createSessionMcpServer } from '../src/server/mcp.js';
import { ContextManager } from '../src/server/context.js';
import { ToolRegistry } from '../src/registry/tools.js';
import { PromptRegistry } from '../src/registry/prompts.js';
import { MiddlewareManager } from '../src/utils/middleware.js';

describe('Dynamic Resource URI Templates (RFC 6570)', () => {
  describe('Unit: ResourceRegistry & URI Template Matching', () => {
    it('registers dynamic resource templates and retrieves by uriTemplate or name', () => {
      const registry = new ResourceRegistry();

      registry.registerTemplate({
        uriTemplate: 'users://{userId}/profile',
        name: 'user_profile',
        description: 'User profile resource',
        mimeType: 'application/json',
        handler: (uri, params) => ({ id: params.userId })
      });

      expect(registry.has('users://{userId}/profile')).toBe(true);
      expect(registry.hasTemplate('users://{userId}/profile')).toBe(true);
      expect(registry.hasTemplate('user_profile')).toBe(true);
      expect(registry.hasTemplate('non_existent')).toBe(false);

      const tplByUri = registry.getTemplate('users://{userId}/profile');
      expect(tplByUri).toBeDefined();
      expect(tplByUri?.name).toBe('user_profile');

      const tplByName = registry.getTemplate('user_profile');
      expect(tplByName).toBeDefined();
      expect(tplByName?.uriTemplate).toBe('users://{userId}/profile');

      const all = registry.getAllTemplates();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe('user_profile');
    });

    it('throws error when registering template with empty uriTemplate', () => {
      const registry = new ResourceRegistry();
      expect(() => {
        registry.registerTemplate({
          uriTemplate: '',
          handler: () => 'ok'
        });
      }).toThrow('Resource template uriTemplate must be a non-empty string');
    });

    it('matches incoming URIs and extracts template parameters', () => {
      const registry = new ResourceRegistry();

      registry.registerTemplate({
        uriTemplate: 'repos://{owner}/{repo}/issues/{id}',
        handler: (uri, params) => params
      });

      const match = registry.findMatchingTemplate('repos://facebook/react/issues/42');
      expect(match).toBeDefined();
      expect(match?.params).toEqual({
        owner: 'facebook',
        repo: 'react',
        id: '42'
      });

      const noMatch = registry.findMatchingTemplate('repos://facebook/react/pulls/42');
      expect(noMatch).toBeUndefined();
    });
  });

  describe('Return Normalization: normalizeResourceResult', () => {
    it('leaves valid ReadResourceResult untouched while ensuring uri is set', () => {
      const input = {
        contents: [{ text: 'custom', mimeType: 'text/custom' }]
      };
      const normalized = normalizeResourceResult(input, 'test://item');
      expect(normalized.contents[0].uri).toBe('test://item');
      expect((normalized.contents[0] as any).text).toBe('custom');
    });

    it('converts plain strings to text resource contents', () => {
      const res = normalizeResourceResult('hello world', 'memo://1', 'text/plain');
      expect(res.contents).toHaveLength(1);
      expect(res.contents[0]).toEqual({
        uri: 'memo://1',
        mimeType: 'text/plain',
        text: 'hello world'
      });
    });

    it('converts plain objects to JSON resource contents', () => {
      const res = normalizeResourceResult({ score: 99, status: 'active' }, 'data://1');
      expect(res.contents).toHaveLength(1);
      expect(res.contents[0].mimeType).toBe('application/json');
      expect(JSON.parse((res.contents[0] as any).text)).toEqual({ score: 99, status: 'active' });
    });

    it('converts Buffer / binary to base64 blob resource contents', () => {
      const buffer = Buffer.from('binary-data');
      const res = normalizeResourceResult(buffer, 'files://doc.bin');
      expect(res.contents[0].mimeType).toBe('application/octet-stream');
      expect((res.contents[0] as any).blob).toBe(buffer.toString('base64'));
    });
  });

  describe('McpApp Integration & Programmatic Reading', () => {
    it('registers templates via app.resourceTemplate() and app.resource() shorthand', () => {
      const app = createMcpServer({ name: 'test-app' });

      // 1. Explicit app.resourceTemplate
      app.resourceTemplate({
        uriTemplate: 'memo://{category}/{id}',
        name: 'memo_by_category',
        handler: (uri, params) => `Category: ${params.category}, ID: ${params.id}`
      });

      // 2. Auto-detection via app.resource with uri containing template variables
      app.resource({
        uri: 'users://{userId}/settings',
        name: 'user_settings',
        handler: (uri, params) => ({ userId: (params as any)?.userId, darkMode: true })
      });

      // 3. Explicit uriTemplate passed to app.resource
      app.resource({
        uriTemplate: 'logs://{service}/{date}',
        name: 'service_logs',
        handler: (uri, params) => `Logs for ${params.service} on ${params.date}`
      });

      expect(app.getResourceTemplate('memo_by_category')).toBeDefined();
      expect(app.getResourceTemplate('user_settings')).toBeDefined();
      expect(app.getResourceTemplate('service_logs')).toBeDefined();

      const templates = app.getResourceTemplates();
      expect(templates.length).toBe(3);
    });

    it('matches templates via app.matchResourceTemplate()', () => {
      const app = createMcpServer({ name: 'test-app' });

      app.resourceTemplate({
        uriTemplate: 'orders://{orderId}/items/{itemId}',
        name: 'order_item',
        handler: () => ({})
      });

      const match = app.matchResourceTemplate('orders://ord-100/items/item-5');
      expect(match).toBeDefined();
      expect(match?.template.name).toBe('order_item');
      expect(match?.params).toEqual({
        orderId: 'ord-100',
        itemId: 'item-5'
      });
    });

    it('reads static resources and dynamic templates via app.readResource()', async () => {
      const app = createMcpServer({
        name: 'test-reader',
        context: async () => ({ tenant: 'acme-corp' })
      });

      // Static resource
      app.resource({
        uri: 'info://about',
        name: 'About App',
        handler: (uri, ctx: any) => ({ name: 'test-reader', tenant: ctx.tenant })
      });

      // Dynamic template resource
      app.resourceTemplate<{ tenant: string }>({
        uriTemplate: 'users://{userId}/summary',
        name: 'user_summary',
        handler: (uri, params, ctx) => {
          return {
            userId: params.userId,
            tenant: ctx.tenant,
            url: uri.href
          };
        }
      });

      // 1. Read static resource
      const staticResult = await app.readResource('info://about');
      expect(staticResult.contents).toHaveLength(1);
      const staticData = JSON.parse((staticResult.contents[0] as any).text);
      expect(staticData).toEqual({ name: 'test-reader', tenant: 'acme-corp' });

      // 2. Read template resource with parameter extraction
      const templateResult = await app.readResource('users://usr_12345/summary');
      expect(templateResult.contents).toHaveLength(1);
      const templateData = JSON.parse((templateResult.contents[0] as any).text);
      expect(templateData).toEqual({
        userId: 'usr_12345',
        tenant: 'acme-corp',
        url: 'users://usr_12345/summary'
      });

      // 3. Read non-existent resource throws error
      await expect(app.readResource('users://unknown/invalid/path')).rejects.toThrow(
        'Resource not found: "users://unknown/invalid/path"'
      );
    });
  });

  describe('End-to-End MCP Client Protocol Integration', () => {
    it('lists resource templates, reads parametric resources, and autocompletes template variables', async () => {
      const app = createMcpServer({
        name: 'mcp-server-test',
        version: '2.0.0',
        context: async () => ({ env: 'test' })
      });

      // Register dynamic resource template with completions and list callback
      app.resourceTemplate({
        uriTemplate: 'notes://{category}/{noteId}',
        name: 'note_resource',
        description: 'Personal category notes',
        mimeType: 'text/markdown',
        complete: {
          category: (val) => ['work', 'personal', 'ideas'].filter((c) => c.startsWith(val)),
          noteId: (val) => ['todo-1', 'todo-2', 'meeting-notes'].filter((n) => n.startsWith(val))
        },
        list: () => [
          {
            uri: 'notes://work/todo-1',
            name: 'Work Todo 1',
            description: 'First work task'
          }
        ],
        handler: (uri, params) => {
          return `# Note: ${params.noteId}\nCategory: ${params.category}\nFull URI: ${uri.href}`;
        }
      });

      // Wire up in-memory transport using createSessionMcpServer
      const toolRegistry = new ToolRegistry();
      const promptRegistry = new PromptRegistry();
      const contextManager = new ContextManager(async () => ({ env: 'test' }));
      await contextManager.initialize();
      const middlewareManager = new MiddlewareManager();

      const server = createSessionMcpServer({
        name: app.config.name,
        version: app.config.version,
        toolRegistry,
        resourceRegistry: app.resourceRegistry,
        promptRegistry,
        contextManager,
        middlewareManager,
        logger: app.logger
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);

      // 1. List Resource Templates
      const templatesResponse = await client.listResourceTemplates();
      expect(templatesResponse.resourceTemplates).toBeDefined();
      expect(templatesResponse.resourceTemplates.length).toBe(1);
      expect(templatesResponse.resourceTemplates[0]).toEqual({
        name: 'note_resource',
        uriTemplate: 'notes://{category}/{noteId}',
        description: 'Personal category notes',
        mimeType: 'text/markdown'
      });

      // 2. Read Resource via Template Match
      const readResult = await client.readResource({
        uri: 'notes://work/meeting-notes'
      });
      expect(readResult.contents).toHaveLength(1);
      expect(readResult.contents[0].uri).toBe('notes://work/meeting-notes');
      expect((readResult.contents[0] as any).text).toContain('# Note: meeting-notes');
      expect((readResult.contents[0] as any).text).toContain('Category: work');
      expect((readResult.contents[0] as any).text).toContain('Full URI: notes://work/meeting-notes');

      // 3. Autocomplete Template Variable
      const completionCategory = await client.complete({
        ref: { type: 'ref/resource', uri: 'notes://{category}/{noteId}' },
        argument: { name: 'category', value: 'w' }
      });
      expect(completionCategory.completion.values).toEqual(['work']);

      const completionNote = await client.complete({
        ref: { type: 'ref/resource', uri: 'notes://{category}/{noteId}' },
        argument: { name: 'noteId', value: 'todo' }
      });
      expect(completionNote.completion.values).toEqual(['todo-1', 'todo-2']);

      await client.close();
      await server.close();
    });

    it('tests PromptRegistry register, get, getAll, and has methods directly', () => {
      const reg = new PromptRegistry();
      expect(reg.has('greet')).toBe(false);
      expect(reg.get('greet')).toBeUndefined();
      expect(reg.getAll()).toEqual([]);

      reg.register({
        name: 'greet',
        description: 'Greeting prompt',
        handler: () => ({ messages: [] })
      });

      expect(reg.has('greet')).toBe(true);
      expect(reg.get('greet')?.name).toBe('greet');
      expect(reg.getAll()).toHaveLength(1);
    });
  });
});
