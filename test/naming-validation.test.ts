import { describe, it, expect } from 'vitest';
import {
  createMcpServer,
  isValidToolName,
  validateToolName,
  isValidServerName,
  validateServerName,
  isValidPromptName,
  validatePromptName,
  validateParameterName,
  sanitizeToolName,
  sanitizeServerName
} from '../src/index.js';

describe('Naming Validation (MCP & LLM Tool Conventions)', () => {
  describe('Tool Name Validation', () => {
    it('accepts valid tool names according to MCP & OpenAI/Claude specifications', () => {
      const validNames = [
        'greet',
        'calculate',
        'get_user_by_id',
        'fetch-weather',
        'tool1',
        'tool_v2',
        'ToolName',
        'a',
        'a'.repeat(64),
        'run_step_1-fast'
      ];

      for (const name of validNames) {
        expect(isValidToolName(name)).toBe(true);
        expect(validateToolName(name)).toBe(name);
      }
    });

    it('rejects tool names with spaces', () => {
      expect(isValidToolName('hello world')).toBe(false);
      expect(() => validateToolName('hello world')).toThrow(/Whitespace and spaces are not allowed/);
      expect(() => validateToolName('hello world')).toThrow(/Suggested valid alternative: "hello_world"/);
    });

    it('rejects tool names with dots or path separators', () => {
      expect(isValidToolName('math.add')).toBe(false);
      expect(isValidToolName('user/get')).toBe(false);
      expect(isValidToolName('user\\get')).toBe(false);
      expect(() => validateToolName('math.add')).toThrow(/Dots, slashes, and path separators are not allowed/);
    });

    it('rejects tool names with special symbols or punctuation', () => {
      const invalidSymbols = [
        'calc!',
        'tool:run',
        'add+calc',
        'hello@world',
        'run#1',
        'data$value',
        'search?'
      ];

      for (const name of invalidSymbols) {
        expect(isValidToolName(name)).toBe(false);
        expect(() => validateToolName(name)).toThrow(/Special symbols and unicode characters are not allowed/);
      }
    });

    it('rejects tool names with non-ASCII / unicode characters', () => {
      expect(isValidToolName('türkçe_araç')).toBe(false);
      expect(isValidToolName('ツール')).toBe(false);
      expect(() => validateToolName('türkçe_araç')).toThrow(/Special symbols and unicode characters are not allowed/);
    });

    it('rejects tool names exceeding 64 characters', () => {
      const longName = 'a'.repeat(65);
      expect(isValidToolName(longName)).toBe(false);
      expect(() => validateToolName(longName)).toThrow(/name exceeds 64 characters/);
    });

    it('rejects empty, whitespace-only, or non-string tool names', () => {
      expect(isValidToolName('')).toBe(false);
      expect(isValidToolName('   ')).toBe(false);
      expect(isValidToolName(null)).toBe(false);
      expect(isValidToolName(undefined)).toBe(false);
      expect(isValidToolName(123)).toBe(false);

      expect(() => validateToolName('')).toThrow(/must be a non-empty string/);
      expect(() => validateToolName('   ')).toThrow(/must be a non-empty string/);
      expect(() => validateToolName(null as any)).toThrow(/must be a non-empty string/);
    });

    it('sanitizes messy tool names into compliant identifiers', () => {
      expect(sanitizeToolName('  my tool: calculate!  ')).toBe('my_tool_calculate');
      expect(sanitizeToolName('fetch.webpage/data')).toBe('fetch_webpage_data');
      expect(sanitizeToolName('---run---')).toBe('run');
      expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64);
    });
  });

  describe('Tool Parameter Name Validation', () => {
    it('accepts valid parameter names in inputSchema', () => {
      expect(validateParameterName('name')).toBe('name');
      expect(validateParameterName('user_id')).toBe('user_id');
      expect(validateParameterName('max-results')).toBe('max-results');
      expect(validateParameterName('step1')).toBe('step1');
    });

    it('rejects invalid parameter names in inputSchema', () => {
      expect(() => validateParameterName('user name')).toThrow(/Invalid parameter name "user name"/);
      expect(() => validateParameterName('user.name', 'fetch_user')).toThrow(/in tool "fetch_user"/);
      expect(() => validateParameterName('foo!bar')).toThrow(/must match/);
      expect(() => validateParameterName('')).toThrow(/must be a non-empty string/);
    });

    it('throws when registering a tool with invalid parameter names in app.tool()', () => {
      const app = createMcpServer('test-param-validation');

      expect(() => {
        app.tool({
          name: 'invalid_param_tool',
          inputSchema: {
            'user name with spaces': 'string'
          },
          handler: async () => ({})
        });
      }).toThrow(/Invalid parameter name "user name with spaces" in tool "invalid_param_tool"/);
    });
  });

  describe('Server Name Validation', () => {
    it('accepts valid server names', () => {
      const validServers = [
        'my-mcp',
        'browsertrack',
        'hello_world',
        'app-1',
        'com.example.mcp',
        'a'.repeat(128)
      ];

      for (const name of validServers) {
        expect(isValidServerName(name)).toBe(true);
        expect(validateServerName(name)).toBe(name);
      }
    });

    it('rejects server names with path traversal or separators', () => {
      expect(isValidServerName('../malicious')).toBe(false);
      expect(isValidServerName('foo/bar')).toBe(false);
      expect(isValidServerName('foo\\bar')).toBe(false);

      expect(() => validateServerName('../malicious')).toThrow(/cannot contain path separators/);
      expect(() => validateServerName('foo/bar')).toThrow(/cannot contain path separators/);
    });

    it('rejects Windows reserved device names', () => {
      const reserved = ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1', 'NUL', 'CON'];

      for (const name of reserved) {
        expect(isValidServerName(name)).toBe(false);
        expect(() => validateServerName(name)).toThrow(/reserved system device name/);
      }
    });

    it('rejects server names with spaces or symbols', () => {
      expect(isValidServerName('my server')).toBe(false);
      expect(isValidServerName('server!')).toBe(false);
      expect(isValidServerName('server:1')).toBe(false);

      expect(() => validateServerName('my server')).toThrow(/Server names must contain only alphanumeric/);
    });

    it('rejects server names exceeding 128 characters', () => {
      const longServer = 'a'.repeat(129);
      expect(isValidServerName(longServer)).toBe(false);
      expect(() => validateServerName(longServer)).toThrow(/exceeds maximum length of 128 characters/);
    });

    it('sanitizes messy server names into safe directory and service names', () => {
      expect(sanitizeServerName('My Server / App..v1')).toBe('My-Server-App.v1');
      expect(sanitizeServerName('---bad---')).toBe('bad');
    });

    it('throws when creating an MCP server with an invalid name', () => {
      expect(() => createMcpServer('invalid/server')).toThrow(/cannot contain path separators/);
      expect(() => createMcpServer('bad server name')).toThrow(/Server names must contain only alphanumeric/);
      expect(() => createMcpServer('con')).toThrow(/reserved system device name/);
      expect(() => createMcpServer('')).toThrow(/non-empty string/);
    });
  });

  describe('Prompt Name Validation', () => {
    it('accepts valid prompt names', () => {
      expect(isValidPromptName('greet-user')).toBe(true);
      expect(isValidPromptName('code_review')).toBe(true);
      expect(validatePromptName('greet-user')).toBe('greet-user');
    });

    it('rejects invalid prompt names', () => {
      expect(isValidPromptName('greet user')).toBe(false);
      expect(isValidPromptName('prompt.test')).toBe(false);
      expect(isValidPromptName('')).toBe(false);

      expect(() => validatePromptName('greet user')).toThrow(/Prompt names must match/);
      expect(() => validatePromptName('')).toThrow(/must be a non-empty string/);
    });

    it('throws when registering a prompt with an invalid name in app.prompt()', () => {
      const app = createMcpServer('test-prompt-validation');

      expect(() => {
        app.prompt({
          name: 'bad prompt name',
          handler: async () => ({ messages: [] })
        });
      }).toThrow(/Invalid prompt name "bad prompt name"/);
    });
  });

  describe('Integration with app.tool() Registration', () => {
    it('throws immediately when registering a tool with an invalid name', () => {
      const app = createMcpServer('test-tool-validation');

      expect(() => {
        app.tool({
          name: 'invalid tool with spaces',
          handler: async () => 'ok'
        });
      }).toThrow(/Invalid tool name "invalid tool with spaces"/);

      expect(() => {
        app.tool({
          name: 'math.calculate',
          handler: async () => 'ok'
        });
      }).toThrow(/Dots, slashes, and path separators are not allowed/);

      expect(() => {
        app.tool({
          name: 'tool:bad',
          handler: async () => 'ok'
        });
      }).toThrow(/Special symbols and unicode characters are not allowed/);
    });
  });
});
