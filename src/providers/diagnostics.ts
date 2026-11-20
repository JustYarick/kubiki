import { acceptNativeRecord, diagnostics } from '../core/diagnostics/collector';
import type { DiagnosticRecord } from '../core/diagnostics/model';
export interface NativeDiagnosticStatus {
  epoch: number; enabled: boolean; journalPath: string | null; journalAvailable: boolean;
  dropped: number; queueDropped: number; ioFailures: number;
}
interface Batch extends NativeDiagnosticStatus { records: DiagnosticRecord[]; nextSequence: number }
const revisionKey = Symbol.for('kubiki.diagnostics.configuration-revision');
function nextRevision(): number {
  const global = globalThis as unknown as Record<symbol, number>;
  return global[revisionKey] = (global[revisionKey] ?? 0) + 1;
}
/** One bounded pump per WebView, outside React. Never instrument these calls with their own logger. */
export function createDiagnosticTransport() {
  let generation = 0;
  let cursor = 0;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let active = false;
  let configureQueue = Promise.resolve();
  async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
  function schedule() { if (active && !timer) timer = setTimeout(() => { timer = undefined; void pump(); }, 250); }
  async function pump() {
    if (running || !active) return;
    const current = generation;
    const records = diagnostics.takeBatch();
    running = true;
    try {
      const batch = await invoke<Batch>('diagnostics_exchange', { epoch, afterSequence: cursor, records });
      if (current !== generation || !active) return;
      cursor = batch.nextSequence;
      for (const record of batch.records) if (record.source === 'native') acceptNativeRecord(record);
      diagnostics.nativeStatus({ nativeAvailable: batch.enabled, nativeFileReady: batch.journalAvailable, journalPath: batch.journalPath,
        nativeDropped: batch.dropped, nativeQueueDropped: batch.queueDropped, nativeIoFailures: batch.ioFailures });
    } catch {
      if (current === generation && active) {
        diagnostics.dropBatch(records.length);
        diagnostics.nativeStatus({ nativeAvailable: false, nativeIoFailures: 1 });
      }
    } finally { running = false; schedule(); }
  }
  return {
    configure(enabled: boolean) {
      const current = ++generation;
      const revision = nextRevision();
      active = false; cursor = 0;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // Serialize transitions so a delayed enable cannot reactivate collection after disable.
      configureQueue = configureQueue.then(async () => {
        try {
          const status = await invoke<NativeDiagnosticStatus>('diagnostics_configure', { enabled, revision });
          if (current !== generation) return;
          epoch = status.epoch; active = enabled;
          diagnostics.nativeStatus({ nativeAvailable: status.enabled, nativeFileReady: status.journalAvailable, journalPath: status.journalPath,
            nativeDropped: status.dropped, nativeQueueDropped: status.queueDropped, nativeIoFailures: status.ioFailures });
          schedule();
        } catch {
          if (current === generation && enabled) diagnostics.nativeStatus({ nativeAvailable: false, nativeIoFailures: 1 });
        }
      });
      return configureQueue;
    },
    async clearSaved() {
      const current = ++generation;
      active = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      diagnostics.clear();
      try {
        const status = await invoke<NativeDiagnosticStatus & { cleared: boolean }>('diagnostics_clear', { epoch });
        if (current !== generation) return;
        epoch = status.epoch;
        diagnostics.nativeStatus({ nativeIoFailures: status.ioFailures, nativeFileReady: status.journalAvailable });
        if (!status.cleared) throw new Error('Diagnostic files could not be cleared');
      } finally { if (current === generation) { active = true; schedule(); } }
    },
  };
}
