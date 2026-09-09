import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpServer,
  normalizeSampleInput,
  normalizeSampleResult
} from '../src/index.js';
import { executeSample, executeListRoots } from '../src/utils/sampling.js';
import { createSessionMcpServer } from '../src/server/mcp.js';
import { ContextManager } from '../src/server/context.js';
import { ToolRegistry } from '../src/registry/tools.js';
import { ResourceRegistry } from '../registry/resources.js';
import { PromptRegistry } from '../src/registry/prompts.js';
import { MiddlewareManager } from '../src/utils/middleware.js';

describe('MCP Sampling & Workspace Roots (Item #5)', () => {
  describe('Unit: normalizeSampleInput', () => {
    it('normalizes shorthand string prompt', () => {
      const normalized = normalizeSampleInput('Summarize this document');
      expect(normalized.messages).toHaveLength(1);
      expect(normalized.messages[0]).toEqual({
        role: 'user',
        content: { type: 'text', text: 'Summarize this document' }
      });
      expect(normalized.maxTokens).toBe(1000);
    });

    it('normalizes object with prompt and options', () => {
      const normalized = normalizeSampleInput({
        prompt: 'Translate to French',
        systemPrompt: 'You are a translator',
        maxTokens: 250,
        temperature: 0.2
      });

      expect(normalized.messages[0].content).toEqual({
        type: 'text',
        text: 'Translate to French'
      });
      expect(normalized.systemPrompt).toBe('You are a translator');
      expect(normalized.maxTokens).toBe(250);
      expect(normalized.temperature).toBe(0.2);
    });

    it('normalizes multi-turn chat messages with mixed contents', () => {
      const normalized = normalizeSampleInput({
        messages: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this image:' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
            ]
          }
        ],
        maxTokens: 500
      });

      expect(normalized.messages).toHaveLength(4);
      expect(normalized.messages[0]).toEqual({
        role: 'user',
        content: { type: 'text', text: 'First question' }
      });
      expect(normalized.messages[1]).toEqual({
        role: 'assistant',
        content: { type: 'text', text: 'First answer' }
      });
      expect(normalized.messages[2]).toEqual({
        role: 'user',
        content: { type: 'text', text: 'Analyze this image:' }
      });
      expect(normalized.messages[3]).toEqual({
        role: 'user',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
      });
    });
  });

  describe('Unit: normalizeSampleResult', () => {
    it('normalizes plain text string into SampleResult with JSON data parsing', () => {
      const res = normalizeSampleResult('{"count": 42}');
      expect(res.role).toBe('assistant');
      expect(res.text).toBe('{"count": 42}');
      expect(res.data).toEqual({ count: 42 });
      expect(String(res)).toBe('{"count": 42}');
    });

    it('normalizes standard SDK CreateMessageResult', () => {
      const res = normalizeSampleResult({
        role: 'assistant',
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'text', text: 'Paragraph one.' },
          { type: 'text', text: 'Paragraph two.' }
        ],
        stopReason: 'endTurn'
      });

      expect(res.role).toBe('assistant');
      expect(res.model).toBe('claude-3-5-sonnet');
      expect(res.stopReason).toBe('endTurn');
      expect(res.text).toBe('Paragraph one.\nParagraph two.');
    });
  });

  describe('Fallback / Offline Sampling and Roots', () => {
    it('uses config.onSample and app.onSample fallback when no client is connected', async () => {
      const app = createMcpServer({
        name: 'sample-offline-app',
        onSample: async (params) => {
          return {
            role: 'assistant',
            text: `Echo: ${params.messages[0].content.text}`,
            model: 'mock-model'
          };
        }
      });

      app.tool({
        name: 'ask_ai',
        inputSchema: { query: 'string' },
        handler: async ({ query }, { sample }) => {
          const res = await sample(query);
          return { reply: res.text, model: res.model };
        }
      });

      const toolResult = await app.callTool('ask_ai', { query: 'Hello Antigravity' });
      expect(toolResult.data).toEqual({
        reply: 'Echo: Hello Antigravity',
        model: 'mock-model'
      });

      // Direct app.sample call
      const direct = await app.sample('Direct message');
      expect(direct.text).toBe('Echo: Direct message');

      // Dynamic app.onSample update
      app.onSample(async () => 'Dynamic override');
      const overridden = await app.sample('Anything');
      expect(overridden.text).toBe('Dynamic override');
    });

    it('uses config.onListRoots and app.onListRoots fallback when offline', async () => {
      const app = createMcpServer({
        name: 'roots-offline-app',
        onListRoots: async () => [
          { uri: 'file:///local/project', name: 'local-proj' }
        ]
      });

      app.tool({
        name: 'get_roots',
        handler: async (_args, { listRoots }) => {
          return await listRoots();
        }
      });

      const toolResult = await app.callTool('get_roots');
      expect(toolResult.data).toEqual([
        { uri: 'file:///local/project', name: 'local-proj' }
      ]);

      const directRoots = await app.listRoots();
      expect(directRoots).toEqual([
        { uri: 'file:///local/project', name: 'local-proj' }
      ]);
    });

    it('throws informative error when sampling is attempted with neither client nor fallback', async () => {
      const app = createMcpServer('unconfigured-sample-app');

      app.tool({
        name: 'needs_sample',
        handler: async (_args, { sample }) => {
          return await sample('test');
        }
      });

      await expect(app.callTool('needs_sample', {})).rejects.toThrow(
        /Sampling is unavailable: No connected client session/
      );
    });
  });

  describe('Integration: MCP Client Sampling & Roots Protocol', () => {
    it('handles bidirectional sampling between server tool and connected client', async () => {
      const app = createMcpServer({
        name: 'bidirectional-app',
        version: '1.0.0'
      });

      app.tool({
        name: 'ai_refactor',
        inputSchema: { code: 'string' },
        handler: async ({ code }, { sample }) => {
          const res = await sample({
            prompt: `Refactor this code: ${code}`,
            systemPrompt: 'You are a clean-code assistant.',
            maxTokens: 100
          });
          return { refactored: res.text, modelUsed: res.model };
        }
      });

      const contextManager = new ContextManager();
      await contextManager.initialize();

      const sessionId = 'bidirectional-session-1';
      const server = createSessionMcpServer({
        name: app.config.name,
        version: app.config.version,
        toolRegistry: app.toolRegistry,
        resourceRegistry: app.resourceRegistry,
        promptRegistry: app.promptRegistry,
        contextManager,
        sessionId,
        logger: app.logger
      });

      // Register session in app.sessions
      (app as any).sessions.set(sessionId, { server, transport: {} });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      const client = new Client(
        { name: 'claude-desktop', version: '1.0.0' },
        {
          capabilities: {
            sampling: {},
            roots: { listChanged: true }
          }
        }
      );

      // Client responds to sampling requests from server!
      let samplingCallCount = 0;
      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        samplingCallCount++;
        expect(req.params.messages[0].content).toEqual({
          type: 'text',
          text: 'Refactor this code: const a = 1;'
        });
        expect(req.params.systemPrompt).toBe('You are a clean-code assistant.');

        return {
          role: 'assistant',
          content: { type: 'text', text: 'const refactoredVal = 1;' },
          model: 'claude-3-5-sonnet-20241022',
          stopReason: 'endTurn'
        };
      });

      await client.connect(clientTransport);

      // Client calls the server's tool
      const toolCallResult = await client.callTool({
        name: 'ai_refactor',
        arguments: { code: 'const a = 1;' }
      });

      expect(samplingCallCount).toBe(1);
      const parsedText = (toolCallResult.content as any)[0].text;
      const parsed = JSON.parse(parsedText);
      expect(parsed).toEqual({
        refactored: 'const refactoredVal = 1;',
        modelUsed: 'claude-3-5-sonnet-20241022'
      });

      await client.close();
    });

    it('queries workspace roots and receives roots list changed notifications', async () => {
      const app = createMcpServer('roots-test-app');

      app.tool({
        name: 'inspect_workspaces',
        handler: async (_args, { listRoots }) => {
          const roots = await listRoots();
          return { roots };
        }
      });

      const contextManager = new ContextManager();
      await contextManager.initialize();

      let notifiedRoots: any = null;
      app.onRootsListChanged((roots) => {
        notifiedRoots = roots;
      });

      const sessionId = 'roots-session-1';
      const server = createSessionMcpServer({
        name: app.config.name,
        version: app.config.version,
        toolRegistry: app.toolRegistry,
        resourceRegistry: app.resourceRegistry,
        promptRegistry: app.promptRegistry,
        contextManager,
        sessionId,
        onRootsListChanged: (roots) => {
          (app as any).rootsListChangedListeners.forEach((l: any) => l(roots));
        },
        logger: app.logger
      });

      (app as any).sessions.set(sessionId, { server, transport: {} });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      const client = new Client(
        { name: 'cursor-ide', version: '2.0.0' },
        {
          capabilities: {
            roots: { listChanged: true }
          }
        }
      );

      let currentRoots = [{ uri: 'file:///workspace/app', name: 'main-app' }];
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        return { roots: currentRoots };
      });

      await client.connect(clientTransport);

      // 1. Tool queries roots
      const toolRes = await client.callTool({
        name: 'inspect_workspaces',
        arguments: {}
      });
      const parsed = JSON.parse((toolRes.content as any)[0].text);
      expect(parsed.roots).toEqual([
        { uri: 'file:///workspace/app', name: 'main-app' }
      ]);

      // 2. Client sends roots/list_changed notification
      currentRoots.push({ uri: 'file:///workspace/shared', name: 'shared-lib' });
      await client.notification({
        method: 'notifications/roots/list_changed'
      });

      // Wait a tick for async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(notifiedRoots).toHaveLength(2);
      expect(notifiedRoots[1].name).toBe('shared-lib');

      await client.close();
    });

    it('covers normalizeSampleInput fallbacks, toString, and executeSample error branches', async () => {
      // 1. Empty input fallback message
      const emptyInput = normalizeSampleInput({});
      expect(emptyInput.messages).toHaveLength(1);
      expect(emptyInput.messages[0].content).toEqual({ type: 'text', text: '' });

      // 2. Direct message object content (not string, not array)
      const objContentInput = normalizeSampleInput({
        messages: [
          { role: 'assistant', content: { type: 'text', text: 'raw-object' } as any }
        ]
      });
      expect(objContentInput.messages[0].content).toEqual({ type: 'text', text: 'raw-object' });

      // 3. normalizeSampleResult toString()
      const normRes = normalizeSampleResult({
        role: 'assistant',
        content: { type: 'text', text: 'result text' }
      });
      expect(normRes.toString()).toBe('result text');

      // 4. executeSample sessionServer throws with fallback handler
      const failingSession = {
        server: {
          createMessage: vi.fn().mockRejectedValue(new Error('Sampling unsupported by client')),
          listRoots: vi.fn().mockRejectedValue(new Error('Roots list failed'))
        }
      };

      const fallbackSampleHandler = vi.fn().mockResolvedValue('Fallback sampled response');
      const fallbackRes = await executeSample('test', undefined, failingSession, fallbackSampleHandler);
      expect(fallbackRes.text).toBe('Fallback sampled response');

      // 5. executeSample sessionServer throws without fallback handler
      await expect(
        executeSample('test', undefined, failingSession, undefined)
      ).rejects.toThrow('Sampling request failed');

      // 6. executeListRoots sessionServer throws with and without fallback handler
      const fallbackRootsHandler = vi.fn().mockResolvedValue([{ uri: 'file:///fallback', name: 'fb' }]);
      const rootsWithFallback = await executeListRoots(failingSession, fallbackRootsHandler);
      expect(rootsWithFallback).toHaveLength(1);
      expect(rootsWithFallback[0].name).toBe('fb');

      const rootsWithoutFallback = await executeListRoots(failingSession, undefined);
      expect(rootsWithoutFallback).toEqual([]);

      // 7. executeListRoots with null sessionServer and no fallback
      const nullRoots = await executeListRoots(null, undefined);
      expect(nullRoots).toEqual([]);
    });
  });
});
