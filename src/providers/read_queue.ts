import { InitialSyncQueue, type ReadPriority } from './initial_sync_queue.ts';
import { requestError } from './errors.ts';

export type ReadLane = 'default' | 'search';

// One budget for interactive/table reads, and a wider parallel lane for on-demand global search.
const reads = new InitialSyncQueue(4);
const searchReads = new InitialSyncQueue(16);

export async function queuedRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  priority: ReadPriority = 'normal',
  lane: ReadLane = 'default',
): Promise<T> {
  const abort = signal ?? new AbortController().signal;
  const queue = lane === 'search' ? searchReads : reads;
  let result!: T;
  await queue.run(async () => { result = await read(); }, abort, priority);
  if (abort.aborted) throw requestError('cancelled', 'Read was cancelled', { operation: 'read' });
  return result;
}
