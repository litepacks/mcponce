import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeState } from '../types.js';

export class StateManager {
  private statePath: string;

  constructor(dataDir: string) {
    this.statePath = path.join(dataDir, 'runtime.json');
  }

  get path(): string {
    return this.statePath;
  }

  /**
   * Reads runtime metadata from runtime.json.
   * Returns null if file does not exist or content is corrupt.
   */
  read(): RuntimeState | null {
    try {
      if (!fs.existsSync(this.statePath)) {
        return null;
      }
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const data = JSON.parse(raw);
      if (
        typeof data.pid === 'number' &&
        typeof data.port === 'number' &&
        typeof data.name === 'string'
      ) {
        return data as RuntimeState;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Writes runtime state atomically using a temporary file and rename.
   */
  write(state: RuntimeState): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = path.join(dir, `.runtime.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.statePath);
  }

  /**
   * Cleans up runtime state file if it belongs to current PID.
   */
  clean(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const state = this.read();
        if (!state || state.pid === process.pid) {
          fs.unlinkSync(this.statePath);
        }
      }
    } catch {}
  }

  /**
   * Force removes runtime state file (used in stale recovery).
   */
  forceClean(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        fs.unlinkSync(this.statePath);
      }
    } catch {}
  }
}
