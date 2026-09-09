import type { Logger, LogLevel } from '../types.js';
import { FileLoggerWriter, formatLogLine } from './file-logger.js';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export class DefaultLogger implements Logger {
  private writer: FileLoggerWriter;
  private level: LogLevel;
  private logToStderr: boolean;

  constructor(options: {
    logDir: string;
    level?: LogLevel;
    retentionDays?: number;
    logToStderr?: boolean;
  }) {
    this.writer = new FileLoggerWriter(options.logDir, options.retentionDays ?? 7);
    this.level = options.level ?? 'info';
    this.logToStderr = options.logToStderr ?? false;
  }

  get directory(): string {
    return this.writer.directory;
  }

  readLogs(limit?: number): string[] {
    return this.writer.readRecentLogs(limit);
  }

  setLogToStderr(enabled: boolean): void {
    this.logToStderr = enabled;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    // Always write to log files
    this.writer.write(level, message, meta);

    // If configured or level is error, write to stderr (NEVER stdout!)
    if (this.logToStderr || level === 'error') {
      try {
        const line = formatLogLine(level, message, meta);
        process.stderr.write(line);
      } catch {}
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
}
