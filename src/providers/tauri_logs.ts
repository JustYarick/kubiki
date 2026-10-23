import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError } from './errors';

/** One bounded log read. Mirrors the Rust `LogSliceRequest` command contract. */
export interface LogSliceParams {
  resource: ResourceRef;
  container: string;
  previous: boolean;
  /** Initial load: keep the last N lines (0..=10000). */
  tail_lines?: number;
  /** Poll resume: lines written after this RFC3339 timestamp. */
  since_time?: string;
  /** Initial load relative window; mutually exclusive with since_time. */
  since_seconds?: number;
}

/**
 * Lens-style log reads: every call is an independent bounded request, never a
 * follow stream. The native command re-validates identity and pins the Pod UID.
 */
export async function fetchLogSlice(params: LogSliceParams, signal?: AbortSignal): Promise<string> {
  const info = { operation: 'logs', context: params.resource.context, resource: params.resource };
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw requestError('unsupported', 'Live Pod logs require the desktop app.', info);
  }
  if (signal?.aborted) throw requestError('timeout', 'Log read was cancelled', info);
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const text = await invoke<unknown>('get_pod_log_slice', { request: params });
    if (typeof text !== 'string') throw requestError('internal', 'Log reader returned an invalid slice', info, 500);
    return text;
  } catch (error) {
    throw normalizeK8sError(error, info);
  }
}
