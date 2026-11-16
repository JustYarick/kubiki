export type ReadPriority = 'high' | 'normal' | 'low';

/** Bound initial LISTs until their snapshots arrive, rather than only IPC registration. */
export class InitialSyncQueue {
  private running = 0;
  private high: (() => void)[] = [];
  private normal: (() => void)[] = [];
  private low: (() => void)[] = [];
  private readonly lowCap: number;
  constructor(private readonly concurrency = 4) {
    this.lowCap = Math.max(1, concurrency - 1);
  }

  run(task: () => Promise<void>, signal: AbortSignal, priority: ReadPriority = 'normal'): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = priority === 'high' ? this.high : priority === 'low' ? this.low : this.normal;
      const cancel = () => {
        const idx = queue.indexOf(start);
        if (idx >= 0) queue.splice(idx, 1);
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) { resolve(); return; }
        this.running++;
        void task().then(resolve, reject).finally(() => {
          this.running--;
          this.drain();
        });
      };
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      queue.push(start);
      this.drain();
    });
  }

  private drain() {
    while (this.running < this.concurrency) {
      const next = this.high.shift()
        ?? this.normal.shift()
        ?? (this.running < this.lowCap ? this.low.shift() : undefined);
      if (!next) break;
      next();
    }
  }
}
