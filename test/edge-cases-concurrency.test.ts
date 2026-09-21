import { describe, it, expect } from 'vitest';
import { ConcurrencyQueue, QueueManager } from '../src/utils/queue.js';

describe('Edge Cases: Concurrency & Queues', () => {
  describe('1. ConcurrencyQueue Configuration Boundaries', () => {
    it('rejects maxConcurrency < 1 with descriptive error', () => {
      expect(() => new ConcurrencyQueue(0)).toThrow(/maxConcurrency must be at least 1/i);
      expect(() => new ConcurrencyQueue(-1)).toThrow(/maxConcurrency must be at least 1/i);
      expect(() => new ConcurrencyQueue(-100)).toThrow(/maxConcurrency must be at least 1/i);
    });

    it('initializes default concurrency of 1', () => {
      const q = new ConcurrencyQueue();
      expect(q.maxConcurrency).toBe(1);
      expect(q.active).toBe(0);
      expect(q.pending).toBe(0);
    });
  });

  describe('2. Idempotent Release & Slot Accounting', () => {
    it('calling release multiple times does not decrease active count below zero', async () => {
      const q = new ConcurrencyQueue(2);
      const release1 = await q.acquire();
      expect(q.active).toBe(1);

      release1();
      expect(q.active).toBe(0);

      // Duplicate calls must be safe and idempotent
      release1();
      release1();
      expect(q.active).toBe(0);
    });

    it('maintains strict concurrency limits under rapid acquisition and release cycles', async () => {
      const q = new ConcurrencyQueue(3);
      let peakConcurrency = 0;

      const tasks = Array.from({ length: 30 }, async () => {
        const release = await q.acquire();
        if (q.active > peakConcurrency) {
          peakConcurrency = q.active;
        }
        await new Promise((r) => setImmediate(r));
        release();
      });

      await Promise.all(tasks);
      expect(peakConcurrency).toBeLessThanOrEqual(3);
      expect(q.active).toBe(0);
      expect(q.pending).toBe(0);
    });
  });

  describe('3. Queue Cancellation & AbortSignal Edge Cases', () => {
    it('rejects immediately when passed an already-aborted signal', async () => {
      const q = new ConcurrencyQueue(1);
      const controller = new AbortController();
      controller.abort(new Error('Pre-aborted queue acquire'));

      await expect(q.acquire(controller.signal)).rejects.toThrow(/Pre-aborted queue acquire/i);
      expect(q.active).toBe(0);
      expect(q.pending).toBe(0);
    });

    it('dequeues cleanly without slot leakage when aborted while waiting in queue', async () => {
      const q = new ConcurrencyQueue(1);

      // Occupy the only slot
      const releaseFirst = await q.acquire();
      expect(q.active).toBe(1);
      expect(q.pending).toBe(0);

      const controller = new AbortController();
      const waitingPromise = q.acquire(controller.signal);
      expect(q.pending).toBe(1);

      // Abort while still in pending queue
      controller.abort(new Error('Aborted while waiting'));

      await expect(waitingPromise).rejects.toThrow(/Aborted while waiting/i);
      expect(q.pending).toBe(0);
      expect(q.active).toBe(1);

      // Next item can now acquire cleanly once first is released
      const secondAcquire = q.acquire();
      releaseFirst();

      const releaseSecond = await secondAcquire;
      expect(q.active).toBe(1);
      releaseSecond();
      expect(q.active).toBe(0);
    });

    it('aborts multiple waiting queue items in various positions', async () => {
      const q = new ConcurrencyQueue(1);
      const releaseFirst = await q.acquire();

      const c1 = new AbortController();
      const c2 = new AbortController();
      const c3 = new AbortController();

      const p1 = q.acquire(c1.signal);
      const p2 = q.acquire(c2.signal);
      const p3 = q.acquire(c3.signal);

      expect(q.pending).toBe(3);

      // Abort middle item (c2)
      c2.abort(new Error('Abort item 2'));
      await expect(p2).rejects.toThrow(/Abort item 2/i);
      expect(q.pending).toBe(2);

      // Abort first pending item (c1)
      c1.abort(new Error('Abort item 1'));
      await expect(p1).rejects.toThrow(/Abort item 1/i);
      expect(q.pending).toBe(1);

      // Release active slot: p3 should now resolve cleanly
      releaseFirst();
      const releaseP3 = await p3;
      expect(q.active).toBe(1);
      expect(q.pending).toBe(0);
      releaseP3();
      expect(q.active).toBe(0);
    });
  });

  describe('4. QueueManager Named Queues', () => {
    it('creates and caches named queues dynamically', () => {
      const qm = new QueueManager();
      const q1 = qm.getQueue('db-pool', 5);
      const q2 = qm.getQueue('db-pool');

      expect(q1).toBe(q2);
      expect(q1.maxConcurrency).toBe(5);
      expect(Object.keys(qm.getStats()).length).toBe(1);
    });

    it('clears all queues on clear()', () => {
      const qm = new QueueManager();
      qm.getQueue('q1');
      qm.getQueue('q2');
      expect(Object.keys(qm.getStats()).length).toBe(2);

      qm.clear();
      expect(Object.keys(qm.getStats()).length).toBe(0);
    });
  });
});
