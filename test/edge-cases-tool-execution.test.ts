import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createMcpServer, image } from '../src/index.js';

describe('Edge Cases: Tool Execution & Error Resilience', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-edge-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Non-Error Exception Normalization', () => {
    it('normalizes string throws into valid MCP CallToolResult with isError: true', async () => {
      const app = createMcpServer({ name: 'throw-test-app', dataDir: testDir, registerInCentral: false });
      app.tool({
        name: 'throw_string',
        handler: () => {
          throw 'Something went badly wrong as a raw string';
        }
      });

      const res = await app.callTool('throw_string', {}, { throwOnError: false });
      expect(res.isError).toBe(true);
      expect(res.content[0].type).toBe('text');
      expect(res.content[0].text).toContain('Something went badly wrong as a raw string');
    });

    it('normalizes numeric and boolean throws safely', async () => {
      const app = createMcpServer({ name: 'throw-scalar-app', dataDir: testDir, registerInCentral: false });
      app.tool({
        name: 'throw_number',
        handler: () => {
          throw 404;
        }
      });
      app.tool({
        name: 'throw_boolean',
        handler: () => {
          throw false;
        }
      });

      const resNum = await app.callTool('throw_number', {}, { throwOnError: false });
      expect(resNum.isError).toBe(true);
      expect(resNum.content[0].text).toContain('404');

      const resBool = await app.callTool('throw_boolean', {}, { throwOnError: false });
      expect(resBool.isError).toBe(true);
      expect(resBool.content[0].text).toContain('false');
    });

    it('normalizes null and undefined throws safely without TypeError', async () => {
      const app = createMcpServer({ name: 'throw-null-app', dataDir: testDir, registerInCentral: false });
      app.tool({
        name: 'throw_null',
        handler: () => {
          throw null;
        }
      });
      app.tool({
        name: 'throw_undefined',
        handler: () => {
          throw undefined;
        }
      });

      const resNull = await app.callTool('throw_null', {}, { throwOnError: false });
      expect(resNull.isError).toBe(true);
      expect(resNull.content[0].type).toBe('text');
      expect(resNull.content[0].text).toContain('null');

      const resUndef = await app.callTool('throw_undefined', {}, { throwOnError: false });
      expect(resUndef.isError).toBe(true);
      expect(resUndef.content[0].type).toBe('text');
      expect(resUndef.content[0].text).toContain('undefined');
    });

    it('normalizes custom object throws into formatted JSON messages', async () => {
      const app = createMcpServer({ name: 'throw-obj-app', dataDir: testDir, registerInCentral: false });
      app.tool({
        name: 'throw_custom_obj',
        handler: () => {
          throw { status: 'DATABASE_LOCKED', code: 503, retryAfterSec: 5 };
        }
      });

      const res = await app.callTool('throw_custom_obj', {}, { throwOnError: false });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('DATABASE_LOCKED');
      expect(res.content[0].text).toContain('503');
    });
  });

  describe('2. Return Value Normalization Edge Cases', () => {
    it('normalizes falsy primitive returns (0, false, empty string) correctly', async () => {
      const app = createMcpServer({ name: 'falsy-return-app', dataDir: testDir, registerInCentral: false });
      app.tool('return_zero', {}, () => 0 as any);
      app.tool('return_false', {}, () => false as any);
      app.tool('return_empty_string', {}, () => '' as any);

      const res0 = await app.callTool('return_zero', {});
      expect(res0.isError).toBeFalsy();
      expect(res0.data).toBe(0);
      expect(res0.content[0].text).toBe('0');

      const resF = await app.callTool('return_false', {});
      expect(resF.isError).toBeFalsy();
      expect(resF.data).toBe(false);
      expect(resF.content[0].text).toBe('false');

      const resEmpty = await app.callTool('return_empty_string', {});
      expect(resEmpty.isError).toBeFalsy();
      expect(resEmpty.content[0].text).toBe('');
    });

    it('normalizes null and undefined returns into empty text result', async () => {
      const app = createMcpServer({ name: 'null-return-app', dataDir: testDir, registerInCentral: false });
      app.tool('return_null', {}, () => null as any);
      app.tool('return_undefined', {}, () => undefined as any);

      const resNull = await app.callTool('return_null', {});
      expect(resNull.isError).toBeFalsy();
      expect(resNull.content).toEqual([]);
      expect(resNull.data).toBeNull();

      const resUndef = await app.callTool('return_undefined', {});
      expect(resUndef.isError).toBeFalsy();
      expect(resUndef.content).toEqual([]);
      expect(resUndef.data).toBeUndefined();
    });

    it('handles objects with circular references without crashing process', async () => {
      const app = createMcpServer({ name: 'circular-ref-app', dataDir: testDir, registerInCentral: false });
      app.tool('return_circular', {}, () => {
        const obj: any = { name: 'circular_object', count: 1 };
        obj.self = obj; // circular reference
        return obj;
      });

      const res = await app.callTool('return_circular', {}, { throwOnError: false });
      expect(res.content[0].type).toBe('text');
      expect(res.content[0].text.length).toBeGreaterThan(0);
    });

    it('normalizes binary Buffer outputs with auto MIME detection and custom image() helper', async () => {
      const app = createMcpServer({ name: 'buffer-return-app', dataDir: testDir, registerInCentral: false });

      // Minimal valid 1x1 transparent PNG buffer
      const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      app.tool('return_png', {}, () => png1x1);
      app.tool('return_image_helper', {}, () => image(png1x1, 'image/png'));

      const resBuffer = await app.callTool('return_png', {});
      expect(resBuffer.content[0].type).toBe('image');
      expect((resBuffer.content[0] as any).mimeType).toBe('image/png');
      expect((resBuffer.content[0] as any).data).toBeTruthy();

      const resHelper = await app.callTool('return_image_helper', {});
      expect(resHelper.content[0].type).toBe('image');
      expect((resHelper.content[0] as any).mimeType).toBe('image/png');
    });

    it('preserves pre-formatted CallToolResult with isError: true and custom content', async () => {
      const app = createMcpServer({ name: 'preformatted-result-app', dataDir: testDir, registerInCentral: false });
      app.tool('custom_error_result', {}, () => ({
        isError: true,
        content: [
          { type: 'text', text: 'Validation error: code 101' },
          { type: 'text', text: 'Second detail line' }
        ]
      }));

      const res = await app.callTool('custom_error_result', {}, { throwOnError: false });
      expect(res.isError).toBe(true);
      expect(res.content.length).toBe(2);
      expect(res.content[0].text).toBe('Validation error: code 101');
      expect(res.content[1].text).toBe('Second detail line');
    });
  });

  describe('3. Progress Reporting Boundary Conditions', () => {
    it('clamps negative progress to 0 and handles zero total and exceeded total safely', async () => {
      const app = createMcpServer({ name: 'progress-boundary-app', dataDir: testDir, registerInCentral: false });
      const progressUpdates: any[] = [];

      app.tool('boundary_progress_tool', {}, async (_args, { reportProgress }) => {
        reportProgress(-5, 10, 'negative progress');
        reportProgress(0, 0, 'zero total');
        reportProgress(15, 10, 'exceeded total');
        return 'completed';
      });

      const res = await app.callTool('boundary_progress_tool', {}, {
        onProgress: (p) => {
          progressUpdates.push(p);
        }
      });

      expect(res.data).toBe('completed');
      expect(progressUpdates.length).toBe(3);
      // Negative progress is defensively clamped to 0
      expect(progressUpdates[0].progress).toBe(0);
      expect(progressUpdates[1].total).toBe(0);
      expect(progressUpdates[2].progress).toBe(15);
    });
  });

  describe('4. Inter-tool Calling Edge Cases', () => {
    it('propagates cancellation signal through inter-tool call chain', async () => {
      const app = createMcpServer({ name: 'intertool-cancel-app', dataDir: testDir, registerInCentral: false });

      app.tool('leaf_tool', {}, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'leaf_done';
      });

      app.tool('parent_tool', {}, async (_args, { callTool }) => {
        return await callTool('leaf_tool', {}, { throwOnError: false });
      });

      const controller = new AbortController();
      controller.abort(new Error('Pre-aborted parent call'));

      const res = await app.callTool('parent_tool', {}, { signal: controller.signal, throwOnError: false });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/cancelled|aborted/i);
    });

    it('propagates error from inner tool to outer tool when throwOnError is false in inner call', async () => {
      const app = createMcpServer({ name: 'intertool-err-app', dataDir: testDir, registerInCentral: false });

      app.tool('failing_leaf', {}, () => {
        throw new Error('Database connection failed in leaf tool');
      });

      app.tool('parent_caller', {}, async (_args, { callTool }) => {
        const leafRes = await callTool('failing_leaf', {}, { throwOnError: false });
        return {
          innerFailed: leafRes.isError,
          innerMsg: leafRes.content[0].text
        };
      });

      const res = await app.callTool('parent_caller', {});
      expect(res.isError).toBeFalsy();
      expect(res.data.innerFailed).toBe(true);
      expect(res.data.innerMsg).toContain('Database connection failed in leaf tool');
    });
  });
});
