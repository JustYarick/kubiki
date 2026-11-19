import { startDiagnosticOperation } from '../core/diagnostics/collector';
type Invoke = typeof import('@tauri-apps/api/core')['invoke'];
let nativeInvoke: Invoke | undefined;
let loading: Promise<Invoke> | undefined;
/** Instrument the IPC boundary, never its arguments or returned content. Cached dispatch keeps cancellation immediate. */
export function diagnosticInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (nativeInvoke) return dispatch<T>(nativeInvoke, command, args);
  loading ??= import('@tauri-apps/api/core').then(module => nativeInvoke = module.invoke).catch(error => { loading = undefined; throw error; });
  return loading.then(invoke => dispatch<T>(invoke, command, args));
}
function dispatch<T>(invoke: Invoke, command: string, args?: Record<string, unknown>): Promise<T> {
  const call = () => args === undefined ? invoke<T>(command) : invoke<T>(command, args);
  // No per-keystroke telemetry. Diagnostics must never recursively observe itself.
  if (/^(write_|ack_|resize_|diagnostics_)/.test(command)) return call();
  const queryContext = typeof args?.query === 'object' && args.query !== null ? (args.query as Record<string, unknown>).context : undefined;
  const traceId = typeof args?.requestId === 'string' ? args.requestId : typeof args?.subscriptionId === 'string' ? args.subscriptionId : undefined;
  const operation = startDiagnosticOperation(command, { transport: 'tauri', context: args?.context ?? queryContext }, traceId);
  try {
    return call().then(result => { operation.finish(); return result; }, error => { operation.finish(error); throw error; });
  } catch (error) { operation.finish(error); return Promise.reject(error); }
}
