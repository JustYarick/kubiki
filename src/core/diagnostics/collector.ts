import contract from '../../../shared/diagnostics-contract.json';
import { version } from '../../../package.json';
import { DIAGNOSTIC_EVENTS, SEVERITY, diagnosticErrorAttributes, safeDiagnosticAttributes, validTrace, type DiagnosticAttributes, type DiagnosticEvent, type DiagnosticLevel, type DiagnosticRecord, type DiagnosticTrace } from './model';

export const DIAGNOSTIC_CAPACITY = contract.limits.memoryRecords;
const RATE_LIMIT = contract.limits.frontendEventsPerSecond;
const NATIVE_QUEUE_CAPACITY = contract.limits.frontendQueueRecords;
interface Snapshot {
  enabled: boolean; records: readonly DiagnosticRecord[]; evicted: number; rateDropped: number;
  transportDropped: number; consoleFailures: number; nativeDropped: number; nativeQueueDropped: number; nativeIoFailures: number;
  nativeAvailable: boolean; nativeFileReady: boolean; journalPath: string | null;
}
const EMPTY: Snapshot = { enabled: false, records: [], evicted: 0, rateDropped: 0, transportDropped: 0, consoleFailures: 0, nativeDropped: 0, nativeQueueDropped: 0, nativeIoFailures: 0, nativeAvailable: false, nativeFileReady: false, journalPath: null };
let state = { ...EMPTY };
let snapshot: Snapshot = state;
let ring: Array<DiagnosticRecord | undefined> = new Array(DIAGNOSTIC_CAPACITY);
let head = 0; let length = 0; let sequence = 0;
let rateWindow = 0; let rateCount = 0; let captureGeneration = 0;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
let pending: DiagnosticRecord[] = [];
let nativeRequested = false;
const listeners = new Set<() => void>();
const sinkListeners = new Set<() => void>();
function records(): DiagnosticRecord[] { return Array.from({ length }, (_, i) => ring[(head + i) % DIAGNOSTIC_CAPACITY]!); }
function publish() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = undefined;
  snapshot = { ...state, records: records() };
  listeners.forEach(listener => listener());
}
function schedule() { if (listeners.size && !publishTimer) publishTimer = setTimeout(publish, 100); }
function append(record: DiagnosticRecord) {
  if (length === DIAGNOSTIC_CAPACITY) { ring[head] = record; head = (head + 1) % DIAGNOSTIC_CAPACITY; state.evicted++; }
  else { ring[(head + length) % DIAGNOSTIC_CAPACITY] = record; length++; }
  const method = record.severityNumber >= 17 ? 'error' : record.severityNumber >= 13 ? 'warn' : record.severityNumber >= 9 ? 'info' : 'debug';
  try { console[method](`[kubiki.diagnostics] ${JSON.stringify(record)}`); } catch { state.consoleFailures++; }
  schedule();
}
function allowed() {
  if (!state.enabled) return false;
  const window = Math.floor(Date.now() / 1000);
  if (window !== rateWindow) { rateWindow = window; rateCount = 0; }
  if (++rateCount > RATE_LIMIT) { state.rateDropped++; schedule(); return false; }
  return true;
}
export function recordDiagnostic(eventName: DiagnosticEvent, level: DiagnosticLevel = 'DEBUG', attributes: Record<string, unknown> = {}, trace?: DiagnosticTrace) {
  if (!allowed() || !DIAGNOSTIC_EVENTS.includes(eventName) || !(level in SEVERITY)) return;
  const now = new Date().toISOString();
  const record: DiagnosticRecord = {
    schemaVersion: 1, sequence: ++sequence, timestamp: now, observedTimestamp: now,
    severityText: level, severityNumber: SEVERITY[level], eventName, body: eventName.replace(/\./g, ' '),
    source: 'frontend', resource: { 'service.name': 'kubiki', 'service.version': version },
    instrumentationScope: { name: 'kubiki.frontend' }, attributes: safeDiagnosticAttributes(attributes),
    ...(trace && validTrace(trace.traceId, 32) && validTrace(trace.spanId, 16) ? trace : {}),
  };
  append(record);
  if (nativeRequested) {
    if (!state.nativeAvailable || pending.length >= NATIVE_QUEUE_CAPACITY) state.transportDropped++;
    else pending.push(record);
    sinkListeners.forEach(listener => listener());
  }
}
export function startDiagnosticOperation(operation: string, attributes: Record<string, unknown> = {}, requestId?: string) {
  if (!state.enabled) return { trace: undefined, finish: (_error?: unknown) => {} };
  const traceId = requestId?.replace(/-/g, '') ?? crypto.randomUUID().replace(/-/g, '');
  const trace = { traceId, spanId: crypto.randomUUID().replace(/-/g, '').slice(0, 16) };
  const started = performance.now(); const generation = captureGeneration; let finished = false;
  const fields: DiagnosticAttributes = safeDiagnosticAttributes({ ...attributes, operation });
  recordDiagnostic('operation.started', 'DEBUG', fields, trace);
  return { trace, finish(error?: unknown) {
    if (finished || generation !== captureGeneration) return;
    finished = true;
    const duration_ms = Math.round((performance.now() - started) * 100) / 100;
    const failed = arguments.length > 0;
    const failure = failed ? diagnosticErrorAttributes(error) : {};
    const cancelled = failure['error.code'] === 'cancelled';
    recordDiagnostic(!failed ? 'operation.succeeded' : cancelled ? 'operation.cancelled' : 'operation.failed',
      !failed || cancelled ? 'DEBUG' : 'ERROR', { ...fields, ...failure, duration_ms }, trace);
    if (duration_ms >= 2000 && !cancelled) recordDiagnostic('operation.slow', 'WARN', { ...fields, duration_ms }, trace);
  } };
}
export function acceptNativeRecord(input: DiagnosticRecord) {
  if (!allowed() || input.source !== 'native' || !DIAGNOSTIC_EVENTS.includes(input.eventName) || !(input.severityText in SEVERITY)) return;
  if (!Number.isFinite(Date.parse(input.timestamp)) || input.timestamp.length > 40) return;
  append({ ...input, schemaVersion: 1, body: input.eventName.replace(/\./g, ' '),
    severityNumber: SEVERITY[input.severityText], attributes: safeDiagnosticAttributes(input.attributes),
    resource: { 'service.name': 'kubiki', 'service.version': version }, instrumentationScope: { name: 'kubiki.native' },
    traceId: validTrace(input.traceId, 32) ? input.traceId : undefined, spanId: validTrace(input.spanId, 16) ? input.spanId : undefined });
}
export const diagnostics = {
  enabled: () => state.enabled,
  subscribe(listener: () => void) { listeners.add(listener); publish(); return () => { listeners.delete(listener); }; },
  getSnapshot: () => snapshot,
  getRecords: records,
  setEnabled(enabled: boolean, nativeAvailable = false) {
    if (state.enabled === enabled && state.nativeAvailable === nativeAvailable) return;
    captureGeneration++; nativeRequested = enabled && nativeAvailable;
    ring = new Array(DIAGNOSTIC_CAPACITY); head = length = 0; pending = []; rateWindow = rateCount = 0;
    state = { ...EMPTY, enabled, nativeAvailable }; publish();
    if (enabled) recordDiagnostic('diagnostics.enabled', 'INFO', { transport: nativeAvailable ? 'tauri' : 'browser' });
  },
  clear() { pending = []; ring = new Array(DIAGNOSTIC_CAPACITY); head = length = 0; state.evicted = state.rateDropped = state.transportDropped = 0; publish(); },
  nativeStatus(value: Partial<Pick<Snapshot, 'nativeAvailable' | 'nativeFileReady' | 'journalPath' | 'nativeDropped' | 'nativeQueueDropped' | 'nativeIoFailures'>>) { Object.assign(state, value); schedule(); },
  takeBatch() { return pending.splice(0, 100); },
  dropBatch(count: number) { state.transportDropped += count; schedule(); },
  onPending(listener: () => void) { sinkListeners.add(listener); return () => { sinkListeners.delete(listener); }; },
};
