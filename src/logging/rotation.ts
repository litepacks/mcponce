import fs from 'node:fs';
import path from 'node:path';

/**
 * Removes daily log files older than the specified retention period (in days).
 * Keeps current.log untouched.
 */
export function cleanOldLogs(logDir: string, retentionDays: number): void {
  if (retentionDays <= 0 || !fs.existsSync(logDir)) {
    return;
  }

  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const dateRegex = /^\d{4}-\d{2}-\d{2}\.log$/;

  try {
    const files = fs.readdirSync(logDir);
    for (const file of files) {
      if (!dateRegex.test(file)) {
        continue;
      }
      const filePath = path.join(logDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
