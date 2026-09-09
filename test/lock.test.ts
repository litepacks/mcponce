import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LockManager } from '../src/runtime/lock.js';

describe('LockManager', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('acquires lock when no lock exists', () => {
    const lock = new LockManager(testDir);
    expect(lock.tryAcquire('test-app')).toBe(true);

    const data = lock.readLock();
    expect(data).not.toBeNull();
    expect(data?.name).toBe('test-app');
    expect(data?.pid).toBe(process.pid);

    lock.release();
    expect(lock.readLock()).toBeNull();
  });

  it('rejects second lock acquisition attempt', () => {
    const lock1 = new LockManager(testDir);
    const lock2 = new LockManager(testDir);

    expect(lock1.tryAcquire('test-app')).toBe(true);
    expect(lock2.tryAcquire('test-app')).toBe(false);

    lock1.release();
    // After lock1 releases, lock2 can acquire
    expect(lock2.tryAcquire('test-app')).toBe(true);
    lock2.release();
  });

  it('forceRelease clears existing lock file', () => {
    const lock1 = new LockManager(testDir);
    expect(lock1.tryAcquire('test-app')).toBe(true);

    const lock2 = new LockManager(testDir);
    lock2.forceRelease();

    expect(lock2.tryAcquire('test-app')).toBe(true);
    lock2.release();
  });

  it('tests path getter, hasLockFile, foreign lock release, and corrupt JSON', () => {
    const lock = new LockManager(testDir);
    expect(lock.path).toContain('instance.lock');
    expect(lock.hasLockFile()).toBe(false);

    // Acquire lock
    expect(lock.tryAcquire('my-app')).toBe(true);
    expect(lock.hasLockFile()).toBe(true);

    // Overwrite lock with another PID
    const lockPath = lock.path;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, name: 'other', createdAt: '2026-01-01' }), 'utf-8');

    // Calling release from current process should NOT delete other PID's lock
    lock.release();
    expect(lock.hasLockFile()).toBe(true);

    // Overwrite with invalid JSON
    fs.writeFileSync(lockPath, 'not-valid-json', 'utf-8');
    expect(lock.readLock()).toBeNull();

    // forceRelease will remove even corrupt lock
    lock.forceRelease();
    expect(lock.hasLockFile()).toBe(false);
  });

  it('covers forceRelease with active fd, non-existing parent directory, and errors in lock', () => {
    // 1. Non-existing nested directory
    const nestedDir = path.join(testDir, 'nested', 'deep');
    const lockNested = new LockManager(nestedDir);
    expect(lockNested.tryAcquire('nested-app')).toBe(true);
    // 2. forceRelease with this.fd !== null
    lockNested.forceRelease();
    expect(lockNested.hasLockFile()).toBe(false);

    // 3. tryAcquire throwing non-EEXIST error
    const lockErr = new LockManager(testDir);
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      const err: any = new Error('Permission denied');
      err.code = 'EACCES';
      throw err;
    });
    expect(() => lockErr.tryAcquire('err-app')).toThrow('Permission denied');
    openSpy.mockRestore();

    // 4. hasLockFile error catch
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementationOnce(() => {
      throw new Error('Disk I/O error');
    });
    expect(lockErr.hasLockFile()).toBe(false);
    existsSpy.mockRestore();
  });
});
