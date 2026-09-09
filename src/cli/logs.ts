import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../runtime/config.js';

export async function printLogs(config: ResolvedConfig<any>, limit = 50): Promise<void> {
  const logDir = config.logDir;
  const currentLog = path.join(logDir, 'current.log');

  console.log(`Log directory: ${logDir}`);

  if (!fs.existsSync(currentLog)) {
    console.log('No logs found yet.');
    return;
  }

  const content = fs.readFileSync(currentLog, 'utf-8');
  const lines = content.trim().split('\n').filter((l) => l.length > 0);
  const recent = lines.slice(-limit);

  console.log(`--- Recent logs (${recent.length} lines) ---`);
  for (const line of recent) {
    console.log(line);
  }
}
