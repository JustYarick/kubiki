/** Bound initial LISTs until their snapshots arrive, rather than only IPC registration. */
export class InitialSyncQueue {
  private running = 0;
  private pending: (() => void)[] = [];
  constructor(private readonly concurrency = 4) {}

  run(task: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending = this.pending.filter(item => item !== start);
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
      this.pending.push(start);
      this.drain();
    });
  }

  private drain() {
    while (this.running < this.concurrency && this.pending.length) this.pending.shift()!();
  }
}
