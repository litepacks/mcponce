import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, z, type ToolAnnotations } from '../src/index.js';
import { createSessionMcpServer } from '../src/server/mcp.js';
import { ContextManager } from '../src/server/context.js';
import { MiddlewareManager } from '../src/utils/middleware.js';

describe('Tool Annotations, Title, OutputSchema & Dynamic Updates', () => {
  it('registers tool with title, annotations, and outputSchema and exposes them over MCP', async () => {
    const app = createMcpServer({
      name: 'annotated-server',
      version: '1.2.0'
    });

    const annotations: ToolAnnotations = {
      title: 'Fetch User Profile',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
      priority: 0.95,
      audience: ['user', 'assistant']
    };

    app.tool({
      name: 'get_user_profile',
      title: 'Fetch User Profile',
      description: 'Fetches user details by user ID',
      annotations,
      inputSchema: {
        userId: 'string'
      },
      outputSchema: z.object({
        userId: z.string(),
        displayName: z.string(),
        active: z.boolean()
      }),
      async handler({ userId }) {
        return {
          userId,
          displayName: `User ${userId}`,
          active: true
        };
      }
    });

    // 1. Verify in local registry
    const tool = app.getTool('get_user_profile');
    expect(tool).toBeDefined();
    expect(tool?.title).toBe('Fetch User Profile');
    expect(tool?.annotations).toEqual(annotations);
    expect(tool?.outputSchema).toBeDefined();

    // 2. Connect via MCP Client
    const contextManager = new ContextManager();
    await contextManager.initialize();
    const middlewareManager = new MiddlewareManager();

    const sessionId = 'annotated-session-1';
    const server = createSessionMcpServer({
      name: app.config.name,
      version: app.config.version,
      toolRegistry: app.toolRegistry,
      resourceRegistry: app.resourceRegistry,
      promptRegistry: app.promptRegistry,
      contextManager,
      middlewareManager,
      sessionId,
      subscriptionRegistry: app.subscriptionRegistry,
      logger: app.logger
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // 3. Inspect tools/list via MCP client
    const toolsResult = await client.listTools();
    const mcpTool = toolsResult.tools.find((t) => t.name === 'get_user_profile');
    expect(mcpTool).toBeDefined();
    expect(mcpTool?.title).toBe('Fetch User Profile');
    expect(mcpTool?.description).toBe('Fetches user details by user ID');
    expect((mcpTool as any)?.annotations).toEqual(annotations);
    expect(mcpTool?.outputSchema).toBeDefined();
    expect((mcpTool?.outputSchema as any)?.type).toBe('object');
    expect((mcpTool?.outputSchema as any)?.properties?.displayName?.type).toBe('string');

    // 4. Call tool via MCP client and check output
    const callResult = await client.callTool({
      name: 'get_user_profile',
      arguments: { userId: 'alice-42' }
    });

    expect(callResult.isError).toBeFalsy();
    expect((callResult as any).structuredContent).toEqual({
      userId: 'alice-42',
      displayName: 'User alice-42',
      active: true
    });

    await client.close();
  });

  it('advertises listChanged capabilities and dynamically registers tools on active sessions', async () => {
    const app = createMcpServer({
      name: 'dynamic-server',
      version: '1.0.0'
    });

    // Initial tool and resource
    app.tool('initial_echo', { message: 'string' }, async ({ message }) => `echo: ${message}`);
    app.resource({
      uri: 'system://version',
      name: 'Version Info',
      handler: () => ({ version: '1.0.0' })
    });
    app.prompt({
      name: 'initial_prompt',
      description: 'Initial prompt',
      handler: async () => ({ messages: [] })
    });

    const contextManager = new ContextManager();
    await contextManager.initialize();

    const sessionId = 'dynamic-session-1';
    const server = createSessionMcpServer({
      name: app.config.name,
      version: app.config.version,
      toolRegistry: app.toolRegistry,
      resourceRegistry: app.resourceRegistry,
      promptRegistry: app.promptRegistry,
      contextManager,
      sessionId,
      subscriptionRegistry: app.subscriptionRegistry,
      logger: app.logger
    });

    // Register active session in app.sessions
    (app as any).sessions.set(sessionId, { server, transport: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // Verify capabilities
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
    expect(caps?.prompts?.listChanged).toBe(true);
    expect(caps?.resources?.listChanged).toBe(true);

    // Track notifications
    let toolListChangedCount = 0;
    let promptListChangedCount = 0;
    let resourceListChangedCount = 0;

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      toolListChangedCount++;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptListChangedCount++;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceListChangedCount++;
    });

    // Dynamically register a new tool at runtime
    app.tool({
      name: 'dynamic_calculator',
      title: 'Dynamic Calculator',
      description: 'Calculates the sum of two numbers',
      inputSchema: { a: 'number', b: 'number' },
      async handler({ a, b }) {
        return { sum: a + b };
      }
    });

    // Wait for the asynchronous notification to be processed on transport
    expect(toolListChangedCount).toBeGreaterThanOrEqual(1);

    // Query tools via client - new tool should be immediately visible
    const tools = await client.listTools();
    const dynamicTool = tools.tools.find((t) => t.name === 'dynamic_calculator');
    expect(dynamicTool).toBeDefined();
    expect(dynamicTool?.title).toBe('Dynamic Calculator');

    // Call newly registered dynamic tool
    const calcResult = await client.callTool({
      name: 'dynamic_calculator',
      arguments: { a: 15, b: 27 }
    });
    expect(calcResult.isError).toBeFalsy();
    expect(calcResult.content[0].type).toBe('text');
    expect(JSON.parse((calcResult.content[0] as any).text)).toEqual({ sum: 42 });

    // Dynamically register a new resource at runtime
    app.resource({
      uri: 'metrics://memory',
      name: 'Memory Metrics',
      handler: () => ({ heap: 1024 })
    });
    expect(resourceListChangedCount).toBeGreaterThanOrEqual(1);

    const resources = await client.listResources();
    expect(resources.resources.some((r) => r.uri === 'metrics://memory')).toBe(true);

    // Dynamically register a new prompt at runtime
    app.prompt({
      name: 'dynamic_review',
      description: 'Dynamic review prompt',
      handler: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Review' } }] })
    });
    expect(promptListChangedCount).toBeGreaterThanOrEqual(1);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((p) => p.name === 'dynamic_review')).toBe(true);

    // Verify programmatic notification counts
    const toolNotified = await app.notifyToolListChanged();
    expect(toolNotified).toBe(1);

    const promptNotified = await app.notifyPromptListChanged();
    expect(promptNotified).toBe(1);

    const resourceNotified = await app.notifyResourceListChanged();
    expect(resourceNotified).toBe(1);

    await client.close();
  });
});
