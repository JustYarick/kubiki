import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { diagnostics, DIAGNOSTIC_CAPACITY, recordDiagnostic, startDiagnosticOperation } from '../../src/core/diagnostics/collector';
import { diagnosticErrorAttributes, safeDiagnosticAttributes } from '../../src/core/diagnostics/model';
import { HttpReadTransport } from '../../src/providers/read_transport';

beforeEach(() => {
  vi.useFakeTimers();
  for (const method of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  diagnostics.setEnabled(false); diagnostics.setEnabled(true);
});
afterEach(() => { diagnostics.setEnabled(false); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('admits only operational metadata, without invoking getters or stringifying errors', () => {
  const input = { operation: 'get_resource', context: 'testbed', message: 'Bearer sensitive-value', credentials: { token: 'sensitive-value' }, 'resource.name': 'synthetic', 'http.route': '/api/{version}/namespaces/{namespace}/{resource}/{name}', 'k8s.watch': true, 'duration_ms': 4 };
  Object.defineProperty(input, 'namespace', { get() { throw new Error('should not execute'); } });
  expect(safeDiagnosticAttributes(input)).toEqual({ operation: 'get_resource', context: 'testbed', 'resource.name': 'synthetic', 'http.route': '/api/{version}/namespaces/{namespace}/{resource}/{name}', 'k8s.watch': true, duration_ms: 4 });
  expect(diagnosticErrorAttributes(new Error('Bearer sensitive-value'))).toEqual({ 'error.code': 'unknown', 'exception.type': 'Error' });
  expect(diagnosticErrorAttributes({ name: 'sensitive-value', message: 'secret', code: 'secret', status: 403 })).toEqual({ 'error.code': 'unknown', 'exception.type': 'Error', 'http.response.status_code': 403 });
  const getter = vi.fn(() => { throw new Error('private rejection getter'); });
  const rejection = Object.defineProperty(new TypeError('private'), 'code', { get: getter });
  expect(diagnosticErrorAttributes(rejection)).toEqual({ 'error.code': 'unknown', 'exception.type': 'TypeError' });
  expect(getter).not.toHaveBeenCalled();
});
it('is silent and empty when disabled, including pending operation completions after re-enabling', () => {
  const operation = startDiagnosticOperation('get_resources');
  diagnostics.setEnabled(false);
  recordDiagnostic('runtime.error', 'ERROR', { message: 'private' });
  expect(diagnostics.getRecords()).toEqual([]);
  expect(console.error).not.toHaveBeenCalled();
  diagnostics.setEnabled(true); const before = diagnostics.getRecords().length;
  operation.finish(new Error('old response'));
  expect(diagnostics.getRecords()).toHaveLength(before);
});
it('bounds retention, rate and forwarding independently and reports discards', () => {
  diagnostics.setEnabled(false); diagnostics.setEnabled(true, true);
  for (let batch = 0; batch < 10; batch++) {
    vi.advanceTimersByTime(1001);
    for (let i = 0; i < 250; i++) recordDiagnostic('watch.batch', 'TRACE', { 'batch.count': i });
  }
  expect(diagnostics.getRecords()).toHaveLength(DIAGNOSTIC_CAPACITY);
  expect(diagnostics.takeBatch()).toHaveLength(100);
  let snapshot = diagnostics.getSnapshot();
  const unsubscribe = diagnostics.subscribe(() => {}); snapshot = diagnostics.getSnapshot();
  expect(snapshot.evicted).toBeGreaterThan(0);
  expect(snapshot.transportDropped).toBeGreaterThan(0);
  for (let i = 0; i < 1000; i++) recordDiagnostic('watch.batch');
  vi.advanceTimersByTime(101);
  expect(diagnostics.getSnapshot().rateDropped).toBeGreaterThan(0);
  unsubscribe();
});
it('console failure cannot fail an application operation or erase its buffered event', () => {
  vi.mocked(console.error).mockImplementation(() => { throw new Error('console closed'); });
  expect(() => recordDiagnostic('runtime.error', 'ERROR')).not.toThrow();
  expect(diagnostics.getRecords()[diagnostics.getRecords().length - 1]?.eventName).toBe('runtime.error');
  const unsubscribe = diagnostics.subscribe(() => {});
  expect(diagnostics.getSnapshot().consoleFailures).toBe(1); unsubscribe();
});
it('correlates start/finish, recognizes undefined rejections and preserves a bounded duration', () => {
  const operation = startDiagnosticOperation('get_resources', {}, '01234567-89ab-cdef-0123-456789abcdef');
  vi.advanceTimersByTime(2100); operation.finish(undefined); operation.finish();
  const records = diagnostics.getRecords().filter(record => record.traceId === '0123456789abcdef0123456789abcdef');
  expect(records.map(record => record.eventName)).toEqual(['operation.started', 'operation.failed', 'operation.slow']);
  expect(records[0].spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(records[1].attributes.duration_ms).toBe(2100);
});
it('records real HTTP status metadata and W3C headers while excluding URL queries and response bodies', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'forbidden', message: 'Bearer sensitive-value', status: 403 }), { status: 403 })));
  const pending = new HttpReadTransport().request('get_resource', 'resource', { name: 'synthetic', token: 'sensitive-value' }, { operation: 'get_resource', context: 'testbed' });
  await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
  const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
  expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const serialized = JSON.stringify(diagnostics.getRecords());
  expect(serialized).toContain('forbidden'); expect(serialized).not.toContain('sensitive-value');
  expect(serialized).not.toContain('token');
});
