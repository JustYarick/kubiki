import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDiagnosticTransport, type NativeDiagnosticStatus } from '../../src/providers/diagnostics';
import { diagnostics } from '../../src/core/diagnostics/collector';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
const status = (enabled = true, epoch = 1): NativeDiagnosticStatus => ({ enabled, epoch, journalPath: '/synthetic/application.jsonl', journalAvailable: true, dropped: 0, queueDropped: 0, ioFailures: 0 });
let transport: ReturnType<typeof createDiagnosticTransport>;
beforeEach(() => {
  vi.useFakeTimers();
  for (const method of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  diagnostics.setEnabled(false); diagnostics.setEnabled(true, true);
  transport = createDiagnosticTransport();
  native.invoke.mockImplementation(async (command, args) => command === 'diagnostics_configure' ? status(args.enabled, args.enabled ? 1 : 0)
    : { ...status(), records: [], nextSequence: 0 });
});
afterEach(async () => { await transport.configure(false); diagnostics.setEnabled(false); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); native.invoke.mockReset(); });
it('serializes enable/disable and does not reactivate after a slow enable response', async () => {
  let finish!: (value: NativeDiagnosticStatus) => void;
  native.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const enabling = transport.configure(true);
  await vi.advanceTimersByTimeAsync(0);
  diagnostics.setEnabled(false);
  const disabling = transport.configure(false);
  finish(status()); await Promise.all([enabling, disabling]);
  await vi.advanceTimersByTimeAsync(1000);
  const calls = native.invoke.mock.calls;
  expect(calls.map(call => call[0])).toEqual(['diagnostics_configure', 'diagnostics_configure']);
  expect(calls[1][1]).toMatchObject({ enabled: false });
  expect(calls[1][1].revision).toBeGreaterThan(calls[0][1].revision);
});
it('drops late native poll results after disabling, even if the frontend has already re-enabled', async () => {
  let finish!: (value: unknown) => void;
  await transport.configure(true);
  native.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(250);
  diagnostics.setEnabled(false); await transport.configure(false);
  diagnostics.setEnabled(true, true); await transport.configure(true);
  const baseline = diagnostics.getRecords().length;
  finish({ ...status(), nextSequence: 10, records: [{ ...diagnostics.getRecords()[0], source: 'native', eventName: 'kubernetes.request.failed', attributes: {}, sequence: 10 }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(diagnostics.getRecords()).toHaveLength(baseline);
});
it('returns to live polling with the new lease when clearing files fails', async () => {
  await transport.configure(true);
  native.invoke.mockImplementationOnce(async () => ({ ...status(true, 2), ioFailures: 1, cleared: false }));
  await expect(transport.clearSaved()).rejects.toThrow('could not be cleared');
  await vi.advanceTimersByTimeAsync(250);
  expect(native.invoke).toHaveBeenLastCalledWith('diagnostics_exchange', expect.objectContaining({ epoch: 2 }));
});
