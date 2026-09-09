import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../types.js';
import { cleanOldLogs } from './rotation.js';

export function formatLogLine(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  timestamp: string = new Date().toISOString()
): string {
  let metaStr = '';
  if (meta && Object.keys(meta).length > 0) {
    metaStr =
      ' ' +
      Object.entries(meta)
        .map(([k, v]) => {
          if (v === undefined || v === null) return `${k}=${v}`;
          if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
          if (typeof v === 'string' && (v.includes(' ') || v.includes('\n') || v.includes('"'))) {
            return `${k}=${JSON.stringify(v)}`;
          }
          return `${k}=${v}`;
        })
        .join(' ');
  }
  return `${timestamp} ${level.toUpperCase()} ${message}${metaStr}\n`;
}

export class FileLoggerWriter {
  private logDir: string;
  private currentLogPath: string;
  private retentionDays: number;
  private lastRotationCheck = 0;
  private dirEnsured = false;
  private cachedDateStr = '';
  private cachedDailyLogPath = '';

  constructor(logDir: string, retentionDays = 7) {
    this.logDir = logDir;
    this.currentLogPath = path.join(logDir, 'current.log');
    this.retentionDays = retentionDays;
  }

  get directory(): string {
    return this.logDir;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.dirEnsured = true;
  }

  private getDailyLogPath(dateStr: string): string {
    if (this.cachedDateStr === dateStr) {
      return this.cachedDailyLogPath;
    }
    this.cachedDateStr = dateStr;
    this.cachedDailyLogPath = path.join(this.logDir, `${dateStr}.log`);
    return this.cachedDailyLogPath;
  }

  write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    try {
      this.ensureDir();
      const now = new Date();
      const iso = now.toISOString();
      const line = formatLogLine(level, message, meta, iso);

      // Append to current.log
      fs.appendFileSync(this.currentLogPath, line, 'utf-8');

      // Append to daily log file (YYYY-MM-DD.log)
      const dateStr = iso.slice(0, 10);
      const dailyLogPath = this.getDailyLogPath(dateStr);
      fs.appendFileSync(dailyLogPath, line, 'utf-8');

      // Run rotation check once an hour
      const nowMs = now.getTime();
      if (nowMs - this.lastRotationCheck > 3600000) {
        this.lastRotationCheck = nowMs;
        cleanOldLogs(this.logDir, this.retentionDays);
      }
    } catch {
      // Never crash if logging fails
    }
  }

  /**
   * Reads the most recent log lines from current.log.
   */
  readRecentLogs(limit = 100): string[] {
    try {
      if (!fs.existsSync(this.currentLogPath)) {
        return [];
      }
      const content = fs.readFileSync(this.currentLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter((l) => l.length > 0);
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }
}
