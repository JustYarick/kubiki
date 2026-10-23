import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchLogSlice } from '../../src/providers/tauri_logs';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
const request = {
  resource: { ...resourceQuery('test', 'Pod', 'backend'), name: 'web', uid: 'uid' },
  container: 'app',
  previous: false,
  tail_lines: 500,
  since_seconds: undefined as number | undefined,
};
beforeEach(() => {
  mock.invoke.mockReset().mockResolvedValue('2026-10-20T08:00:00Z ok\n');
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());
it('calls the slice command with the request contract', async () => {
  const text = await fetchLogSlice(request, new AbortController().signal);
  expect(text).toBe('2026-10-20T08:00:00Z ok\n');
  expect(mock.invoke).toHaveBeenCalledOnce();
  expect(mock.invoke.mock.calls[0][0]).toBe('get_pod_log_slice');
  expect(mock.invoke.mock.calls[0][1].request).toEqual(request);
});
it('passes poll resumes and rejects non-string slices', async () => {
  const poll = { ...request, tail_lines: undefined, since_seconds: undefined, since_time: '2026-10-20T08:00:01Z' };
  await fetchLogSlice(poll);
  expect(mock.invoke.mock.calls[0][1].request.since_time).toBe('2026-10-20T08:00:01Z');
  expect(mock.invoke.mock.calls[0][1].request.tail_lines).toBeUndefined();
  mock.invoke.mockResolvedValue(42);
  await expect(fetchLogSlice(request)).rejects.toMatchObject({ code: 'internal', status: 500 });
});
it('keeps native error payloads and refuses browser environments', async () => {
  mock.invoke.mockRejectedValue({ code: 'forbidden', status: 403, message: 'pods/log denied' });
  await expect(fetchLogSlice(request)).rejects.toMatchObject({ status: 403, message: 'pods/log denied' });
  vi.stubGlobal('window', {});
  await expect(fetchLogSlice(request)).rejects.toMatchObject({ code: 'unsupported' });
});
