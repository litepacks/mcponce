import fs from 'node:fs';
import path from 'node:path';

export interface LockData {
  pid: number;
  name: string;
  createdAt: string;
}

export class LockManager {
  private lockPath: string;
  private fd: number | null = null;

  constructor(dataDir: string) {
    this.lockPath = path.join(dataDir, 'instance.lock');
  }

  get path(): string {
    return this.lockPath;
  }

  /**
   * Checks whether the lock file exists on disk.
   */
  hasLockFile(): boolean {
    try {
      return fs.existsSync(this.lockPath);
    } catch {
      return false;
    }
  }

  /**
   * Attempts to atomically acquire the lock file using 'wx' flag (O_CREAT | O_EXCL).
   * Returns true if successfully acquired, false if lock file already exists.
   */
  tryAcquire(name: string): boolean {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lockData: LockData = {
      pid: process.pid,
      name,
      createdAt: new Date().toISOString()
    };
    const content = JSON.stringify(lockData, null, 2);

    const tmpPath = `${this.lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content);
      try {
        fs.linkSync(tmpPath, this.lockPath);
        return true;
      } catch (linkErr: any) {
        if (linkErr.code === 'EEXIST') {
          return false;
        }
        // Fallback to openSync('wx') if linkSync is unsupported on filesystem
        try {
          this.fd = fs.openSync(this.lockPath, 'wx');
          fs.writeSync(this.fd, content);
          return true;
        } catch (openErr: any) {
          if (openErr.code === 'EEXIST') {
            return false;
          }
          throw openErr;
        }
      } finally {
        try {
          if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
          }
        } catch {}
      }
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Reads lock metadata if the file exists and is valid JSON.
   */
  readLock(): LockData | null {
    try {
      if (!fs.existsSync(this.lockPath)) {
        return null;
      }
      const content = fs.readFileSync(this.lockPath, 'utf-8');
      return JSON.parse(content) as LockData;
    } catch {
      return null;
    }
  }

  /**
   * Releases the lock held by this process.
   */
  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }

    try {
      if (fs.existsSync(this.lockPath)) {
        // Only unlink if the lock file is ours
        const lock = this.readLock();
        if (!lock || lock.pid === process.pid) {
          fs.unlinkSync(this.lockPath);
        }
      }
    } catch {}
  }

  /**
   * Force removes the lock file (used when recovering from a verified crashed/stale instance).
   */
  forceRelease(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }

    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }
}
