import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DefaultLogger } from '../src/logging/logger.js';
import { cleanOldLogs } from '../src/logging/rotation.js';

describe('logging and rotation', () => {
  let testDir: string;
  let logDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    logDir = path.join(testDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('writes structured logs to current.log and daily log file', () => {
    const logger = new DefaultLogger({
      logDir,
      level: 'info'
    });

    logger.info('server:start', { pid: 12345, port: 54321 });
    logger.debug('should:be:ignored'); // debug < info

    const currentLog = path.join(logDir, 'current.log');
    expect(fs.existsSync(currentLog)).toBe(true);

    const content = fs.readFileSync(currentLog, 'utf-8');
    expect(content).toContain('INFO server:start pid=12345 port=54321');
    expect(content).not.toContain('should:be:ignored');

    // Check daily log file
    const dateStr = new Date().toISOString().slice(0, 10);
    const dailyLog = path.join(logDir, `${dateStr}.log`);
    expect(fs.existsSync(dailyLog)).toBe(true);
    expect(fs.readFileSync(dailyLog, 'utf-8')).toContain('server:start');
  });

  it('never writes logs to stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logger = new DefaultLogger({
      logDir,
      level: 'info'
    });

    logger.info('test-stdout-safe', { data: 'test' });
    logger.error('test-error-stdout-safe', { error: 'boom' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('writes to stderr when logToStderr is enabled or on error', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = new DefaultLogger({
      logDir,
      level: 'info',
      logToStderr: true
    });

    logger.info('diagnostic message');
    expect(stderrSpy).toHaveBeenCalled();
    expect(stderrSpy.mock.calls[0][0].toString()).toContain('INFO diagnostic message');

    stderrSpy.mockRestore();
  });

  it('rotates and cleans up daily logs older than retention period', () => {
    const oldDate = '2020-01-01.log';
    const oldLogPath = path.join(logDir, oldDate);
    fs.writeFileSync(oldLogPath, 'old log content', 'utf-8');

    // Set mtime to 30 days ago
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldLogPath, past, past);

    // Current log
    const currentLogPath = path.join(logDir, 'current.log');
    fs.writeFileSync(currentLogPath, 'active log', 'utf-8');

    cleanOldLogs(logDir, 7);

    // Old file should be deleted, current log preserved
    expect(fs.existsSync(oldLogPath)).toBe(false);
    expect(fs.existsSync(currentLogPath)).toBe(true);

    // Edge cases for cleanOldLogs
    cleanOldLogs(logDir, 0); // retentionDays <= 0
    cleanOldLogs('/non/existent/path/for/mcponce/logs', 7); // dir does not exist

    // File that does not match date regex
    const otherFile = path.join(logDir, 'other.txt');
    fs.writeFileSync(otherFile, 'other', 'utf-8');
    cleanOldLogs(logDir, 7);
    expect(fs.existsSync(otherFile)).toBe(true);
  });

  it('tests logger log levels, directory, and readLogs', () => {
    const logger = new DefaultLogger({
      logDir,
      level: 'warn'
    });

    expect(logger.directory).toBe(logDir);
    logger.info('should be ignored');
    logger.warn('warning event', { code: 123 });
    logger.error('error event', { code: 500 });

    const logs = logger.readLogs();
    expect(logs.some((l) => l.includes('warning event'))).toBe(true);
    expect(logs.some((l) => l.includes('error event'))).toBe(true);
    expect(logs.some((l) => l.includes('should be ignored'))).toBe(false);
  });

  it('formatLogLine serializes complex metadata, nested objects, and special strings', async () => {
    const { formatLogLine } = await import('../src/logging/file-logger.js');

    const line = formatLogLine('info', 'user_action', {
      user: { id: 42, role: 'admin' },
      tags: ['sys', 'auth'],
      quoted: 'value with "quotes"',
      multiline: 'line1\nline2',
      nullable: null,
      missing: undefined
    }, '2026-01-01T00:00:00.000Z');

    expect(line).toBe(
      '2026-01-01T00:00:00.000Z INFO user_action user={"id":42,"role":"admin"} tags=["sys","auth"] quoted="value with \\"quotes\\"" multiline="line1\\nline2" nullable=null missing=undefined\n'
    );
  });

  it('safely handles circular reference metadata without crashing logger', () => {
    const logger = new DefaultLogger({
      logDir,
      level: 'info'
    });

    const circularMeta: any = { note: 'circular-test' };
    circularMeta.self = circularMeta;

    // Logging circular reference should NOT throw
    expect(() => {
      logger.info('circular-event', circularMeta);
    }).not.toThrow();
  });

  it('strictly enforces log level hierarchy across debug, info, warn, and error', () => {
    const debugLogger = new DefaultLogger({
      logDir: path.join(testDir, 'debug-logs'),
      level: 'debug'
    });
    debugLogger.debug('d_msg');
    debugLogger.info('i_msg');
    debugLogger.warn('w_msg');
    debugLogger.error('e_msg');

    const debugLogs = debugLogger.readLogs();
    expect(debugLogs.some((l) => l.includes('d_msg'))).toBe(true);
    expect(debugLogs.some((l) => l.includes('i_msg'))).toBe(true);
    expect(debugLogs.some((l) => l.includes('w_msg'))).toBe(true);
    expect(debugLogs.some((l) => l.includes('e_msg'))).toBe(true);

    const errorLogger = new DefaultLogger({
      logDir: path.join(testDir, 'error-logs'),
      level: 'error'
    });
    errorLogger.debug('d_msg');
    errorLogger.info('i_msg');
    errorLogger.warn('w_msg');
    errorLogger.error('e_msg');

    const errorLogs = errorLogger.readLogs();
    expect(errorLogs.some((l) => l.includes('d_msg'))).toBe(false);
    expect(errorLogs.some((l) => l.includes('i_msg'))).toBe(false);
    expect(errorLogs.some((l) => l.includes('w_msg'))).toBe(false);
    expect(errorLogs.some((l) => l.includes('e_msg'))).toBe(true);
  });

  it('cleanOldLogs safely tolerates subdirectories and non-log files inside log directory', () => {
    const subDir = path.join(logDir, 'nested-subdir');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'subfile.txt'), 'sub');

    const dotFile = path.join(logDir, '.dotfile.log');
    fs.writeFileSync(dotFile, 'dot');

    const invalidDateLog = path.join(logDir, '9999-99-99.log');
    fs.writeFileSync(invalidDateLog, 'future date');

    expect(() => cleanOldLogs(logDir, 7)).not.toThrow();
    expect(fs.existsSync(subDir)).toBe(true);
    expect(fs.existsSync(dotFile)).toBe(true);
  });

  it('readLogs returns empty array for non-existent log directory and respects limit', () => {
    const emptyLogger = new DefaultLogger({
      logDir: path.join(testDir, 'empty-nonexistent-dir'),
      level: 'info'
    });
    expect(emptyLogger.readLogs()).toEqual([]);

    const logger = new DefaultLogger({
      logDir,
      level: 'info'
    });
    for (let i = 1; i <= 5; i++) {
      logger.info(`event-${i}`);
    }

    const limited = logger.readLogs(2);
    expect(limited.length).toBe(2);
    expect(limited[0]).toContain('event-4');
    expect(limited[1]).toContain('event-5');
  });

  it('dynamically toggles stderr streaming via setLogToStderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new DefaultLogger({
      logDir,
      level: 'info',
      logToStderr: false
    });

    logger.info('no-stderr');
    expect(stderrSpy).not.toHaveBeenCalled();

    logger.setLogToStderr(true);
    logger.info('yes-stderr');
    expect(stderrSpy).toHaveBeenCalled();
    expect(stderrSpy.mock.calls[0][0].toString()).toContain('yes-stderr');

    stderrSpy.mockRestore();
  });
});
