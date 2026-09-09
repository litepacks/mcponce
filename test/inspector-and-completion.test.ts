import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMcpServer } from '../src/index.js';
import { filterCompletionValues, resolveCompletion } from '../src/utils/completion.js';
import { openBrowser } from '../src/utils/browser.js';
import { PromptRegistry } from '../src/registry/prompts.js';
import { ResourceRegistry } from '../src/registry/resources.js';
import { ToolRegistry } from '../src/registry/tools.js';

describe('Interactive Web Inspector & MCP Autocomplete Protocol (Item #7)', () => {
  describe('filterCompletionValues', () => {
    it('filters values matching query with prefix matches prioritized', () => {
      const items = ['apple', 'pineapple', 'apricot', 'banana', 'crabapple'];
      const res = filterCompletionValues(items, 'ap');

      expect(res.values[0]).toBe('apple');
      expect(res.values[1]).toBe('apricot');
      expect(res.values).toContain('pineapple');
      expect(res.values).toContain('crabapple');
      expect(res.values).not.toContain('banana');
      expect(res.total).toBe(4);
      expect(res.hasMore).toBe(false);
    });

    it('caps completion options at 100 items and flags hasMore', () => {
      const items = Array.from({ length: 150 }, (_, i) => `item_${i.toString().padStart(3, '0')}`);
      const res = filterCompletionValues(items, 'item');

      expect(res.values.length).toBe(100);
      expect(res.total).toBe(150);
      expect(res.hasMore).toBe(true);
    });
  });

  describe('resolveCompletion', () => {
    it('resolves prompt argument autocompletions', async () => {
      const promptRegistry = new PromptRegistry();
      promptRegistry.register({
        name: 'review_code',
        argsSchema: { lang: 'string' },
        complete: {
          lang: async (val) => ['typescript', 'python', 'rust', 'go'].filter((l) => l.startsWith(val))
        },
        handler: () => ({ messages: [] })
      });

      const res = await resolveCompletion({
        promptRegistry,
        ref: { type: 'ref/prompt', name: 'review_code' },
        argument: { name: 'lang', value: 'py' }
      });

      expect(res.values).toEqual(['python']);
      expect(res.total).toBe(1);
    });

    it('resolves resource template parameter autocompletions', async () => {
      const resourceRegistry = new ResourceRegistry();
      resourceRegistry.registerTemplate({
        uriTemplate: 'org://{orgId}/repos/{repoId}',
        complete: {
          orgId: (val) => ['litepacks', 'facebook', 'microsoft'].filter((o) => o.includes(val))
        },
        handler: (uri, params) => `Repo: ${params.repoId}`
      });

      const res = await resolveCompletion({
        resourceRegistry,
        ref: { type: 'ref/resource', uri: 'org://{orgId}/repos/{repoId}' },
        argument: { name: 'orgId', value: 'lite' }
      });

      expect(res.values).toEqual(['litepacks']);
    });

    it('resolves tool argument autocompletions', async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register({
        name: 'query_database',
        inputSchema: { table: 'string' },
        complete: {
          table: () => ['users', 'orders', 'products', 'billing']
        },
        handler: () => 'result'
      });

      const res = await resolveCompletion({
        toolRegistry,
        ref: { type: 'ref/tool', name: 'query_database' },
        argument: { name: 'table', value: 'user' }
      });

      expect(res.values).toEqual(['users']);
    });

    it('gracefully returns empty array for unknown references or handler errors', async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register({
        name: 'buggy_tool',
        complete: {
          arg: () => {
            throw new Error('Explosion');
          }
        },
        handler: () => 'ok'
      });

      const res = await resolveCompletion({
        toolRegistry,
        ref: { type: 'ref/tool', name: 'buggy_tool' },
        argument: { name: 'arg', value: 'test' }
      });

      expect(res.values).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.hasMore).toBe(false);

      // Null ref or argument
      const nullRef = await resolveCompletion({ ref: null as any, argument: null as any });
      expect(nullRef.values).toEqual([]);

      // Prompt not found or no complete
      const noPrompt = await resolveCompletion({
        ref: { type: 'ref/prompt', name: 'missing' },
        argument: { name: 'x', value: '1' }
      });
      expect(noPrompt.values).toEqual([]);

      // Resource template not found or no complete
      const noResource = await resolveCompletion({
        ref: { type: 'ref/resource', uri: 'notes://missing' },
        argument: { name: 'x', value: '1' }
      });
      expect(noResource.values).toEqual([]);

      // Tool not found or no complete
      const noTool = await resolveCompletion({
        ref: { type: 'ref/tool', name: 'missing' },
        argument: { name: 'x', value: '1' }
      });
      expect(noTool.values).toEqual([]);

      // Unknown ref type
      const unknownRef = await resolveCompletion({
        ref: { type: 'custom/unknown', name: 'whatever' },
        argument: { name: 'x', value: '1' }
      });
      expect(unknownRef.values).toEqual([]);
    });
  });

  describe('openBrowser utility', () => {
    it('returns false when running in CI or NO_BROWSER environment', async () => {
      const origCi = process.env.CI;
      try {
        process.env.CI = '1';
        const result = await openBrowser('http://localhost:3000/inspect');
        expect(result).toBe(false);
      } finally {
        process.env.CI = origCi;
      }
    });
  });

  describe('Interactive Web Inspector HTTP Endpoints', () => {
    let app: ReturnType<typeof createMcpServer>;
    let host: string;
    let port: number;

    beforeEach(async () => {
      app = createMcpServer({
        name: 'inspector-test-app',
        port: 0
      });

      app.tool({
        name: 'calculate_tax',
        description: 'Calculates sales tax for an amount',
        inputSchema: {
          amount: 'number',
          rate: { type: 'number', default: 0.2 }
        },
        cache: { ttlMs: 60000 },
        handler: ({ amount, rate }) => ({
          tax: amount * rate,
          total: amount * (1 + rate)
        })
      });

      app.resource({
        uri: 'config://settings',
        name: 'App Settings',
        description: 'System configurations',
        handler: () => ({ env: 'test', debug: true })
      });

      app.resourceTemplate({
        uriTemplate: 'users://{id}/profile',
        description: 'User profile template',
        complete: {
          id: () => ['101', '102', '103']
        },
        handler: (uri, { id }) => ({ id, name: `User ${id}` })
      });

      app.prompt({
        name: 'welcome',
        description: 'Welcome greeting prompt',
        argsSchema: { name: 'string' },
        complete: {
          name: () => ['Alice', 'Bob', 'Charlie']
        },
        handler: ({ name }) => ({
          messages: [{ role: 'user', content: { type: 'text', text: `Welcome ${name}!` } }]
        })
      });

      const res = await app.start({ background: false });
      host = res.host;
      port = res.port;
    });

    afterEach(async () => {
      await app.stop();
    });

    it('serves the self-contained HTML Web Inspector at GET /inspect', async () => {
      const response = await fetch(`http://${host}:${port}/inspect`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');

      const html = await response.text();
      expect(html).toContain('mcponce Inspector');
      expect(html).toContain('inspector-test-app');
      expect(html).toContain('/inspect/api/state');
      expect(html).toContain('https://cdn.tailwindcss.com');
      expect(html).toContain('https://unpkg.com/euixjs/dist/EUIXEngine.umd.js');
      expect(html).toContain('<uid_spec>');
      expect(html).toContain('</uid_spec>');
      expect(html).toContain('<data_model>');
      expect(html).toContain('/inspect/api/tools/');
      expect(html).toContain('/inspect/api/resources/read');
      expect(html).toContain('/inspect/api/prompts/get');
    });

    it('returns full system metadata and registry state at GET /inspect/api/state', async () => {
      const response = await fetch(`http://${host}:${port}/inspect/api/state`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.server.name).toBe('inspector-test-app');
      expect(data.tools.some((t: any) => t.name === 'calculate_tax')).toBe(true);
      expect(data.resources.some((r: any) => r.uri === 'config://settings')).toBe(true);
      expect(data.resourceTemplates.some((t: any) => t.uriTemplate === 'users://{id}/profile')).toBe(true);
      expect(data.prompts.some((p: any) => p.name === 'welcome')).toBe(true);
    });

    it('executes tools and returns duration & response payload at POST /inspect/api/tools/:name', async () => {
      const response = await fetch(`http://${host}:${port}/inspect/api/tools/calculate_tax`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: { amount: 100, rate: 0.15 } })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.result.data.tax).toBe(15);
      expect(data.result.data.total).toBeCloseTo(115);
      expect(typeof data.durationMs).toBe('number');
    });

    it('reads resources directly at POST /inspect/api/resources/read', async () => {
      // 1. Static resource
      const resStatic = await fetch(`http://${host}:${port}/inspect/api/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'config://settings' })
      });
      expect(resStatic.status).toBe(200);
      const dataStatic = await resStatic.json();
      expect(dataStatic.success).toBe(true);
      expect(dataStatic.result.contents[0].text).toContain('env');

      // 2. Resource template
      const resTpl = await fetch(`http://${host}:${port}/inspect/api/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'users://42/profile' })
      });
      expect(resTpl.status).toBe(200);
      const dataTpl = await resTpl.json();
      expect(dataTpl.success).toBe(true);
      expect(dataTpl.result.contents[0].text).toContain('User 42');
    });

    it('renders prompts directly at POST /inspect/api/prompts/get', async () => {
      const response = await fetch(`http://${host}:${port}/inspect/api/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'welcome', args: { name: 'Antigravity' } })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.result.messages[0].content.text).toBe('Welcome Antigravity!');
    });

    it('resolves completion via POST /inspect/api/complete and app.complete', async () => {
      // Via programmatic app.complete:
      const promptComp = await app.complete(
        { type: 'ref/prompt', name: 'welcome' },
        { name: 'name', value: 'Al' }
      );
      expect(promptComp.values).toEqual(['Alice']);

      // Via inspector HTTP endpoint:
      const res = await fetch(`http://${host}:${port}/inspect/api/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: { type: 'ref/resource', uri: 'users://{id}/profile' },
          argument: { name: 'id', value: '10' }
        })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.values).toEqual(['101', '102', '103']);
    });

    it('inspector error handling for tools, resources, and prompts', async () => {
      // 1. Tool execution failure returns 500
      app.tool({
        name: 'failing_tool',
        handler: async () => {
          throw new Error('Tool exploded');
        }
      });
      const resToolErr = await fetch(`http://${host}:${port}/inspect/api/tools/failing_tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: {} })
      });
      expect(resToolErr.status).toBe(500);
      const dataToolErr = await resToolErr.json();
      expect(dataToolErr.success).toBe(false);
      expect(dataToolErr.error).toContain('Tool exploded');

      // 2. Resource read missing uri returns 400
      const resMissingUri = await fetch(`http://${host}:${port}/inspect/api/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(resMissingUri.status).toBe(400);

      // 3. Resource read not found returns 404
      const resNotFoundUri = await fetch(`http://${host}:${port}/inspect/api/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'nonexistent://res' })
      });
      expect(resNotFoundUri.status).toBe(404);

      // 4. Resource handler throws returns 500
      app.resource({
        uri: 'error://fail',
        handler: async () => {
          throw new Error('Resource failure');
        }
      });
      const resErrUri = await fetch(`http://${host}:${port}/inspect/api/resources/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'error://fail' })
      });
      expect(resErrUri.status).toBe(500);

      // 5. Prompt get missing name returns 400
      const resMissingPrompt = await fetch(`http://${host}:${port}/inspect/api/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(resMissingPrompt.status).toBe(400);

      // 6. Prompt get unknown returns 404
      const resNotFoundPrompt = await fetch(`http://${host}:${port}/inspect/api/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'does_not_exist' })
      });
      expect(resNotFoundPrompt.status).toBe(404);

      // 7. Prompt handler throws returns 500
      app.prompt({
        name: 'failing_prompt',
        handler: async () => {
          throw new Error('Prompt failure');
        }
      });
      const resErrPrompt = await fetch(`http://${host}:${port}/inspect/api/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'failing_prompt' })
      });
      expect(resErrPrompt.status).toBe(500);
    });
  });
});

