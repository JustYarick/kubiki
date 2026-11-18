/** Local diagnostic envelope aligned with the OTel log data model; not an OTLP payload. */
import contract from '../../../shared/diagnostics-contract.json';
export const SEVERITY = contract.levels;
export type DiagnosticLevel = keyof typeof SEVERITY;
export type DiagnosticEvent = keyof typeof contract.events;
export const DIAGNOSTIC_EVENTS = Object.keys(contract.events) as DiagnosticEvent[];
export type DiagnosticAttributes = Record<string, string | number | boolean>;
export interface DiagnosticRecord {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  observedTimestamp: string;
  severityText: DiagnosticLevel;
  severityNumber: number;
  eventName: DiagnosticEvent;
  body: string;
  source: 'frontend' | 'native';
  resource: { 'service.name': 'kubiki'; 'service.version': string };
  instrumentationScope: { name: string };
  attributes: DiagnosticAttributes;
  traceId?: string;
  spanId?: string;
}
export interface DiagnosticTrace { traceId: string; spanId: string }
const TEXT_ATTRIBUTES = new Set<string>(contract.attributes.text);
const NUMBER_ATTRIBUTES = new Set<string>(contract.attributes.number);
/** Closed keys + identifier-shaped values. Payloads, URLs, paths and free-form errors are never accepted. */
export function safeDiagnosticAttributes(input: Record<string, unknown>): DiagnosticAttributes {
  const output: DiagnosticAttributes = {};
  try {
    for (const key of [...TEXT_ATTRIBUTES, ...NUMBER_ATTRIBUTES, contract.attributes.route, ...contract.attributes.boolean]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const value: unknown = descriptor.value;
      if (TEXT_ATTRIBUTES.has(key) && typeof value === 'string' && value.length > 0 && value.length <= contract.limits.textBytes
        && /^[a-zA-Z0-9_.:/@-]+$/.test(value) && !value.includes('://') && !value.startsWith('/')) output[key] = value;
      if (key === 'http.route' && typeof value === 'string' && value.length <= contract.limits.routeBytes && /^\/[a-zA-Z0-9_/{}.-]+$/.test(value)) output[key] = value;
      if ((key === 'k8s.watch' || key === 'k8s.list.paginated') && typeof value === 'boolean') output[key] = value;
      if (NUMBER_ATTRIBUTES.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) output[key] = Math.min(value, Number.MAX_SAFE_INTEGER);
    }
  } catch { /* Instrumentation must not invoke accessors or fail the operation it observes. */ }
  return output;
}
export function validTrace(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value);
}
function dataProperty(input: object, key: string): unknown {
  let current: object | null = input;
  for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}
export function diagnosticErrorAttributes(error: unknown): DiagnosticAttributes {
  // Never stringify rejection bodies, messages, stacks, provider errors or IPC arguments.
  let code = 'unknown'; let type = 'Error'; let status: unknown;
  try { if (error && typeof error === 'object') {
    const errorCode = dataProperty(error, 'code');
    const errorName = dataProperty(error, 'name');
    const codes = new Set(['cancelled', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'timeout', 'rate_limited', 'unavailable', 'invalid_request', 'unsupported', 'bridge_unavailable', 'internal']);
    if (typeof errorCode === 'string' && codes.has(errorCode)) code = errorCode;
    const types = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'K8sRequestError', 'OpenCodeNotStartedError']);
    if (typeof errorName === 'string' && types.has(errorName)) type = errorName;
    if (type === 'AbortError') code = 'cancelled';
    status = dataProperty(error, 'status');
  } } catch { /* Do not execute hostile rejection accessors. */ }
  return safeDiagnosticAttributes({ 'error.code': code, 'exception.type': type, 'http.response.status_code': status });
}
