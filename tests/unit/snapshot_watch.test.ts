import { afterEach, expect, it, vi } from 'vitest';
import { pollResourceSnapshots } from '../../src/providers/snapshot_watch';
import type { WatchBatch } from '../../src/providers/watch_types';
const query = { context: 'prod', group: '', version: 'v1', kind: 'ResourceQuota', namespace: 'team' };
afterEach(() => vi.useRealTimers());
it('polls list-only collections, retains the last snapshot on failure and cancels timers', async () => {
  vi.useFakeTimers(); const abort = new AbortController(); const batches: WatchBatch[] = [];
  const read = vi.fn().mockResolvedValueOnce({ items: [{ metadata: { name: 'quota', uid: 'one' } }] }).mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue({ items: [] });
  const close = await pollResourceSnapshots(query, read, batch => batches.push(batch), abort.signal);
  expect(batches[0].messages[0].event.type).toBe('Delta');
  await vi.advanceTimersByTimeAsync(30000);
  expect(batches[1].messages).toHaveLength(1);
  expect(batches[1].messages[0].event).toMatchObject({ type: 'Status', payload: { phase: 'reconnecting' } });
  await vi.advanceTimersByTimeAsync(30000);
  expect(batches[2].messages[0]).toMatchObject({ sequence: 4, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } });
  abort.abort(); close(); await vi.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(3);
});
it('ignores a response that arrives after cancellation', async () => {
  const abort = new AbortController(); const onBatch = vi.fn(); let complete!: (value: { items: [] }) => void;
  const pending = pollResourceSnapshots(query, () => new Promise(resolve => { complete = resolve; }), onBatch, abort.signal);
  abort.abort(); complete({ items: [] }); const close = await pending; close(); expect(onBatch).not.toHaveBeenCalled();
});
