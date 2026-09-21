import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createMcpServer, z } from '../src/index.js';

describe('E2E Full Protocol Lifecycle: Streamable HTTP (/mcp)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-e2e-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  function parseMcpPayload(raw: string): any {
    // Streamable HTTP responses can be plain JSON or SSE data: {...}
    const lines = raw.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const jsonPart = line.replace(/^data:\s*/, '').trim();
        if (jsonPart) {
          try {
            return JSON.parse(jsonPart);
          } catch {}
        }
      }
    }
    return JSON.parse(raw);
  }

  it('orchestrates a full client session across tools, resources, prompts, completions, and metrics', async () => {
    const app = createMcpServer({
      name: 'e2e-lifecycle-server',
      version: '2.0.0',
      port: 0,
      dataDir: testDir,
      registerInCentral: false
    });

    // 1. Register a tool
    app.tool({
      name: 'calculate_tax',
      description: 'Calculates tax amount given net price and rate',
      inputSchema: z.object({
        net: z.number().describe('Net amount in USD'),
        rate: z.number().default(0.2).describe('Tax rate between 0 and 1')
      }),
      handler: async ({ net, rate }) => {
        const tax = Math.round(net * rate * 100) / 100;
        return {
          net,
          rate,
          tax,
          gross: net + tax
        };
      }
    });

    // 2. Register a resource
    app.resource({
      uri: 'system://info',
      name: 'System Status',
      description: 'Host and node runtime information',
      mimeType: 'application/json',
      handler: async () => {
        return JSON.stringify({
          nodeVersion: process.version,
          platform: process.platform,
          status: 'healthy'
        });
      }
    });

    // 3. Register a prompt with autocompletion
    app.prompt({
      name: 'translate_text',
      description: 'Generates a prompt for translation',
      argsSchema: {
        language: 'string',
        text: 'string'
      },
      complete: {
        language: async (val) => ['turkish', 'english', 'spanish', 'german'].filter((l) => l.startsWith(val))
      },
      handler: async ({ language, text }) => ({
        messages: [
          {
            role: 'user',
            content: `Translate the following text to ${language}:\n\n${text}`
          }
        ]
      })
    });

    const startInfo = await app.start({ role: 'owner' });
    const baseUrl = `http://${startInfo.host}:${startInfo.port}`;

    try {
      // -------------------------------------------------------------
      // Step 1: POST /mcp -> initialize
      // -------------------------------------------------------------
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'init-1',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-test-runner', version: '1.0.0' }
          }
        })
      });

      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const initData = parseMcpPayload(await initRes.text());
      expect(initData.jsonrpc).toBe('2.0');
      expect(initData.result.serverInfo.name).toBe('e2e-lifecycle-server');
      expect(initData.result.protocolVersion).toBe('2024-11-05');

      // -------------------------------------------------------------
      // Step 2: POST /mcp -> notifications/initialized
      // -------------------------------------------------------------
      const notifRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });
      expect(notifRes.status).toBeLessThan(400);

      // -------------------------------------------------------------
      // Step 3: POST /mcp -> tools/list
      // -------------------------------------------------------------
      const listToolsRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'list-tools-1',
          method: 'tools/list'
        })
      });

      expect(listToolsRes.status).toBe(200);
      const toolsData = parseMcpPayload(await listToolsRes.text());
      const tools = toolsData.result.tools;
      expect(tools.some((t: any) => t.name === 'calculate_tax')).toBe(true);

      // -------------------------------------------------------------
      // Step 4: POST /mcp -> tools/call
      // -------------------------------------------------------------
      const callToolRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'call-1',
          method: 'tools/call',
          params: {
            name: 'calculate_tax',
            arguments: { net: 100, rate: 0.18 }
          }
        })
      });

      expect(callToolRes.status).toBe(200);
      const callData = parseMcpPayload(await callToolRes.text());
      expect(callData.result.isError).toBeFalsy();
      const taxResult = JSON.parse(callData.result.content[0].text);
      expect(taxResult.gross).toBe(118);
      expect(taxResult.tax).toBe(18);

      // -------------------------------------------------------------
      // Step 5: POST /mcp -> resources/list and resources/read
      // -------------------------------------------------------------
      const listResRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'list-res-1',
          method: 'resources/list'
        })
      });
      expect(listResRes.status).toBe(200);
      const resListData = parseMcpPayload(await listResRes.text());
      expect(resListData.result.resources.some((r: any) => r.uri === 'system://info')).toBe(true);

      const readRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'read-res-1',
          method: 'resources/read',
          params: { uri: 'system://info' }
        })
      });
      expect(readRes.status).toBe(200);
      const readData = parseMcpPayload(await readRes.text());
      const sysInfo = JSON.parse(readData.result.contents[0].text);
      expect(sysInfo.status).toBe('healthy');
      expect(sysInfo.nodeVersion).toBe(process.version);

      // -------------------------------------------------------------
      // Step 6: POST /mcp -> prompts/list and prompts/get
      // -------------------------------------------------------------
      const listPromptsRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'prompts-list-1',
          method: 'prompts/list'
        })
      });
      expect(listPromptsRes.status).toBe(200);
      const promptsData = parseMcpPayload(await listPromptsRes.text());
      expect(promptsData.result.prompts.some((p: any) => p.name === 'translate_text')).toBe(true);

      const getPromptRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'prompt-get-1',
          method: 'prompts/get',
          params: {
            name: 'translate_text',
            arguments: { language: 'turkish', text: 'Hello World' }
          }
        })
      });
      expect(getPromptRes.status).toBe(200);
      const promptGetData = parseMcpPayload(await getPromptRes.text());
      expect(promptGetData.result.messages[0].content).toContain('Translate the following text to turkish');

      // -------------------------------------------------------------
      // Step 7: POST /mcp -> completion/complete
      // -------------------------------------------------------------
      const completeRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'comp-1',
          method: 'completion/complete',
          params: {
            ref: { type: 'ref/prompt', name: 'translate_text' },
            argument: { name: 'language', value: 'tur' }
          }
        })
      });
      expect(completeRes.status).toBe(200);
      const completeData = parseMcpPayload(await completeRes.text());
      expect(completeData.result.completion.values).toContain('turkish');

      // -------------------------------------------------------------
      // Step 8: GET /metrics -> Prometheus exporter verification
      // -------------------------------------------------------------
      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsText = await metricsRes.text();
      expect(metricsText).toContain('mcp_server_info');
      expect(metricsText).toContain('e2e-lifecycle-server');
      expect(metricsText).toContain('mcp_tool_calls_total');
      expect(metricsText).toContain('calculate_tax');

      // -------------------------------------------------------------
      // Step 9: GET /health -> Readiness verification
      // -------------------------------------------------------------
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.ok).toBe(true);
      expect(healthData.name).toBe('e2e-lifecycle-server');
    } finally {
      await app.stop({ force: true });
    }
  });
});
