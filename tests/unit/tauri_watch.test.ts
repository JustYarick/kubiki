import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchTauriResources } from '../../src/providers/tauri_watch';
import { resourceQuery } from '../../src/core/resources/resource_types';
import type { WatchBatch } from '../../src/providers/watch_types';

const mock = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ id: number; onmessage: (batch: WatchBatch) => void }> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, Channel: class {
  id = mock.channels.length + 1;
  onmessage = (_batch: WatchBatch) => {};
  constructor() { mock.channels.push(this); }
} }));
const query = resourceQuery('production', 'Pod');
let unregister: ReturnType<typeof vi.fn>;
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(undefined); mock.channels.length = 0; unregister = vi.fn(); vi.stubGlobal('window', { __TAURI_INTERNALS__: { unregisterCallback: unregister } }); });
afterEach(() => vi.unstubAllGlobals());

it('does not register an already cancelled watch', async () => {
  const abort = new AbortController(); abort.abort(); await watchTauriResources(query, vi.fn(), abort.signal);
  expect(mock.invoke).not.toHaveBeenCalled(); expect(mock.channels).toHaveLength(0);
});
it('isolates subscription IDs and queries, disposes the callback and stops exactly once', async () => {
  const receive = vi.fn(); const abort = new AbortController(); const close = await watchTauriResources(query, receive, abort.signal);
  const id = mock.invoke.mock.calls[0][1].subscriptionId;
  const batch: WatchBatch = { subscription_id: id, query, messages: [] };
  mock.channels[0].onmessage({ ...batch, subscription_id: 'other' });
  mock.channels[0].onmessage({ ...batch, query: { ...query, context: 'other' } });
  mock.channels[0].onmessage(batch); expect(receive).toHaveBeenCalledOnce();
  abort.abort(); close(); mock.channels[0].onmessage(batch);
  expect(receive).toHaveBeenCalledOnce(); expect(unregister).toHaveBeenCalledWith(mock.channels[0].id);
  expect(mock.invoke.mock.calls.filter(([command]) => command === 'stop_resource_watch')).toEqual([['stop_resource_watch', { subscriptionId: id }]]);
});
it('stops again if cancellation beats the native registration acknowledgement', async () => {
  let acknowledge!: () => void;
  mock.invoke.mockImplementation((command: string) => command === 'watch_resources' ? new Promise<void>((resolve) => { acknowledge = resolve; }) : Promise.resolve());
  const abort = new AbortController(); const pending = watchTauriResources(query, vi.fn(), abort.signal);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled());
  abort.abort(); acknowledge(); await pending;
  expect(mock.invoke.mock.calls.filter(([command]) => command === 'stop_resource_watch')).toHaveLength(2);
  expect(unregister).toHaveBeenCalledOnce();
});
it('cleans up a callback when native registration fails and preserves typed errors', async () => {
  mock.invoke.mockImplementation((command: string) => command === 'watch_resources' ? Promise.reject({ code: 'forbidden', status: 403, message: 'denied' }) : Promise.resolve());
  await expect(watchTauriResources(query, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  expect(unregister).toHaveBeenCalledOnce(); expect(mock.invoke).toHaveBeenLastCalledWith('stop_resource_watch', expect.any(Object));
});
