import { batchSize, emptyBatch, mergeBatch, splitBatch, type DrishtiStore, type FlushBatch } from '@drishtikit/core';
import type { Collector } from './collector.js';
import type { FlushOptions } from './options.js';

export interface FlushState {
  lastFlushAt: number | null;
  lastFlushOps: number;
  lastError: string | null;
  failuresInRow: number;
  running: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes the counters of the collector to the store.
 * 1. It swaps the maps, so new samples never wait.
 * 2. It writes in parts of `opsPerSecond` changes, one part each second.
 * 3. A part that fails goes back to the collector. After `maxFailures` failed flushes in a row,
 *    the changes that wait are dropped and counted in `dropped`.
 */
export class Flusher {
  readonly state: FlushState = { lastFlushAt: null, lastFlushOps: 0, lastError: null, failuresInRow: 0, running: false };
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private fastMode = false;
  private inflight: FlushBatch[] = [];

  constructor(
    private readonly collector: Collector,
    private readonly getStore: () => Promise<DrishtiStore>,
    private readonly options: Required<FlushOptions>,
    private readonly warn: (message: string) => void,
  ) {}

  /** Start the timer. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((error: unknown) => this.warn(`flush failed: ${String(error)}`));
    }, this.options.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Changes that are being written now (a copy). The reader merges them into answers. */
  inflightBatch(): FlushBatch {
    const out = emptyBatch();
    for (const part of this.inflight) mergeBatch(out, part);
    return out;
  }

  /** Resolves when no flush is running. */
  async waitIdle(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
  }

  /** Write now. With `fast`, there is no wait between parts (used at shutdown). */
  async flush(options: { fast?: boolean } = {}): Promise<void> {
    if (options.fast) this.fastMode = true;
    if (this.running) {
      await this.running;
      if (!options.fast) return;
    }
    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.fastMode = false;
    }
  }

  private async run(): Promise<void> {
    this.state.running = true;
    try {
      const batch = this.collector.swap();
      const total = batchSize(batch);
      const parts = splitBatch(batch, this.options.opsPerSecond);
      this.inflight = [...parts];
      let failedOps = 0;
      let lastError: unknown;
      let store: DrishtiStore | undefined;
      try {
        store = await this.getStore();
      } catch (error) {
        lastError = error;
      }
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as FlushBatch;
        let failed: FlushBatch | null = null;
        try {
          if (!store) throw lastError;
          failed = (await store.apply(part)).failed;
        } catch (error) {
          lastError = error;
          failed = part;
        }
        if (failed) {
          failedOps += batchSize(failed);
          this.collector.restore(failed);
        }
        this.inflight = this.inflight.filter((p) => p !== part);
        if (i < parts.length - 1 && !this.fastMode && this.options.partDelayMs > 0) await sleep(this.options.partDelayMs);
      }
      this.state.lastFlushAt = Date.now();
      this.state.lastFlushOps = total - failedOps;
      if (failedOps === 0) {
        this.state.failuresInRow = 0;
        this.state.lastError = null;
      } else {
        this.state.failuresInRow++;
        this.state.lastError = String((lastError as Error | undefined)?.message ?? lastError ?? 'some changes were not written');
        if (this.state.failuresInRow >= this.options.maxFailures) {
          const dropped = this.collector.dropCarry();
          this.warn(`flush failed ${this.state.failuresInRow} times in a row; dropped ${dropped} changes`);
          this.state.failuresInRow = 0;
        }
      }
    } finally {
      this.inflight = [];
      this.state.running = false;
    }
  }
}
