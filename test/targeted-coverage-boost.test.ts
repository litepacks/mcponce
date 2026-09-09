import { describe, it, expect, vi } from 'vitest';
import { validatePromptName } from '../src/utils/validation.js';
import { createProgressReporter } from '../src/utils/progress.js';
import { rootToPath, findWorkspaceRoot, resolveWorkspacePath } from '../src/utils/roots.js';
import { sleepWithSignal, raceWithSignal, executeWithRetry } from '../src/utils/retry.js';
import { FileLoggerWriter } from '../src/logging/file-logger.js';
import { ResourceRegistry } from '../src/registry/resources.js';
import { SubscriptionRegistry } from '../src/registry/subscriptions.js';
import { ToolRegistry, normalizeInputSchema } from '../src/registry/tools.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Targeted Coverage Boost: Utils and Registries', () => {
  it('validation: validatePromptName exceeds 64 chars', () => {
    expect(() => validatePromptName('a'.repeat(65))).toThrow('exceeds maximum length of 64 characters');
  });

  it('progress: object format with string total', async () => {
    let captured: any = null;
    const reporter = createProgressReporter({
      toolName: 'demo',
      onProgress: (p) => {
        captured = p;
      }
    });
    await reporter({ progress: 5, total: '10' as any, message: 'processing' });
    expect(captured).toMatchObject({
      tool: 'demo',
      progress: 5,
      total: 10,
      message: 'processing'
    });
  });

  it('roots: rootToPath handles invalid URL fallback, findWorkspaceRoot with string root, and empty roots in resolveWorkspacePath', () => {
    // invalid file url fallback (lines 14-15)
    const fallbackPath = rootToPath('file:///invalid-format-%ZZ');
    expect(fallbackPath).toBeDefined();

    // findWorkspaceRoot with string root (lines 56-57)
    const tmpDir = os.tmpdir();
    const found = findWorkspaceRoot([tmpDir], tmpDir);
    expect(found).toEqual({ uri: tmpDir });

    // resolveWorkspacePath throws if roots is empty (lines 77-78)
    expect(() => resolveWorkspacePath([], 'subpath')).toThrow('No active workspace roots provided');
  });

  it('retry: sleepWithSignal with already aborted signal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('Pre-aborted'));
    await expect(sleepWithSignal(100, ac.signal)).rejects.toThrow('Pre-aborted');
  });

  it('retry: raceWithSignal with already aborted signal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('Signal aborted immediately'));
    await expect(raceWithSignal(Promise.resolve(42), ac.signal)).rejects.toThrow('Signal aborted immediately');
  });

  it('retry: executeWithRetry with 0 attempts', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const res = await executeWithRetry(fn, { name: 'test', config: 0 });
    expect(res).toEqual({ result: 'ok', retries: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retry: executeWithRetry aborts when signal is aborted during retry loop', async () => {
    const ac = new AbortController();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        ac.abort(new Error('Stop retrying'));
        throw new Error('Call 1 failed');
      }
      return 'ok';
    });

    await expect(
      executeWithRetry(fn, {
        name: 'test',
        config: { attempts: 3, backoffMs: 10 },
        signal: ac.signal
      })
    ).rejects.toThrow('Call 1 failed');
  });

  it('file-logger: handles write exceptions gracefully and triggers rotation after 1 hour', () => {
    const tmpLogDir = path.join(os.tmpdir(), `file-logger-test-${Date.now()}`);
    const logger = new FileLoggerWriter(tmpLogDir, 7);

    // Trigger write normally
    logger.write('info', 'First test line');

    // Force rotation check by winding lastRotationCheck back > 1 hour
    (logger as any).lastRotationCheck = Date.now() - 4000000;
    logger.write('info', 'Second test line with rotation check');

    // Make appendFileSync throw to test lines 87-89 catch block
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw new Error('Disk error');
    });

    expect(() => logger.write('error', 'Failing log')).not.toThrow();
    spy.mockRestore();

    try {
      fs.rmSync(tmpLogDir, { recursive: true, force: true });
    } catch {}
  });

  it('resources registry: getTemplate by name, has, hasTemplate, and array params in findMatchingTemplate', () => {
    const registry = new ResourceRegistry();
    registry.registerTemplate({
      name: 'User Template',
      uriTemplate: 'user://{userId}',
      handler: async () => ({ contents: [] })
    });

    // getTemplate by name (line 62)
    const tpl = registry.getTemplate('User Template');
    expect(tpl).toBeDefined();
    expect(tpl?.uriTemplate).toBe('user://{userId}');

    // has and hasTemplate (lines 93-102)
    expect(registry.has('user://{userId}')).toBe(true);
    expect(registry.has('non-existent')).toBe(false);
    expect(registry.hasTemplate('User Template')).toBe(true);
    expect(registry.hasTemplate('non-existent')).toBe(false);

    // findMatchingTemplate with array param in match
    const mockSdkTemplate = {
      uriTemplate: {
        match: (uri: string) => {
          if (uri.includes('array')) {
            return { tags: ['alpha', 'beta'] };
          }
          return null;
        }
      }
    };
    (registry as any).templates.set('mock://tpl', {
      definition: { name: 'Mock', uriTemplate: 'mock://tpl', handler: vi.fn() },
      sdkTemplate: mockSdkTemplate
    });

    const match = registry.findMatchingTemplate('mock://tpl/array');
    expect(match).toBeDefined();
    expect(match?.params).toEqual({ tags: 'alpha,beta' });
  });

  it('subscriptions registry: getAllSubscribedUris, activeSubscriptionCount, and clear', () => {
    const subRegistry = new SubscriptionRegistry();
    subRegistry.subscribe('sess-1', 'res://1');
    subRegistry.subscribe('sess-2', 'res://2');

    expect(subRegistry.getAllSubscribedUris()).toContain('res://1');
    expect(subRegistry.getAllSubscribedUris()).toContain('res://2');
    expect(subRegistry.activeSubscriptionCount).toBe(2);

    subRegistry.clear();
    expect(subRegistry.activeSubscriptionCount).toBe(0);
    expect(subRegistry.getAllSubscribedUris()).toEqual([]);
  });

  it('tools registry: has method, unknown base type fallback, and non-object schema value', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'demo_tool',
      handler: async () => 'done'
    });

    expect(registry.has('demo_tool')).toBe(true);
    expect(registry.has('unknown_tool')).toBe(false);

    // normalizeInputSchema with unknown type and primitive value
    const schemas = normalizeInputSchema({
      customField: 'unknown_type' as any,
      fallbackField: 123 as any
    });

    expect(schemas.customField).toBeDefined();
    expect(schemas.fallbackField).toBeDefined();
  });
});
