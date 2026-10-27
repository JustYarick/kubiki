import { InitialSyncQueue } from './initial_sync_queue.ts';
import { requestError } from './errors.ts';

// One budget for actual reads, shared by all providers and namespace selections.
const reads = new InitialSyncQueue(4);
export async function queuedRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const abort = signal ?? new AbortController().signal;
  let result!: T;
  await reads.run(async () => { result = await read(); }, abort);
  if (abort.aborted) throw requestError('cancelled', 'Read was cancelled', { operation: 'read' });
  return result;
}
