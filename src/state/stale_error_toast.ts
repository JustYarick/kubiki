import { useEffect } from 'react';
import type { K8sRequestError } from '../providers/errors';
import { toast } from './notifications_store';

/** Tracks active stale-refresh warning signatures per view scope so periodic polls never spam duplicate toasts. */
const activeStaleAlerts = new Map<string, string>();

export function resetStaleRefreshToasts(scopePrefix?: string): void {
  if (!scopePrefix) {
    activeStaleAlerts.clear();
    return;
  }
  for (const key of activeStaleAlerts.keys()) {
    if (key.startsWith(scopePrefix)) activeStaleAlerts.delete(key);
  }
}

export function notifyStaleRefreshFailure(options: {
  scopeId: string;
  label: string;
  error: K8sRequestError | null | undefined;
  retainedData: boolean;
  fromCache?: boolean;
}): boolean {
  const { scopeId, label, error, retainedData, fromCache } = options;
  if (!error || !retainedData) {
    activeStaleAlerts.delete(scopeId);
    return false;
  }
  const signature = `${error.code}:${error.message}`;
  if (activeStaleAlerts.get(scopeId) === signature) return false;
  activeStaleAlerts.set(scopeId, signature);
  const title = fromCache ? `Showing cached ${label}` : `Showing stale ${label}`;
  toast.warn(title, `Refresh failed: ${error.message}`);
  return true;
}

/** Emits a deduplicated warning toast when a refresh fails while retained/cached data remains visible. */
export function useStaleRefreshToast(options: {
  scopeId: string;
  label: string;
  error: K8sRequestError | null | undefined;
  retainedData: boolean;
  fromCache?: boolean;
}): void {
  const { scopeId, label, error, retainedData, fromCache } = options;
  const code = error?.code;
  const message = error?.message;
  useEffect(() => {
    notifyStaleRefreshFailure({ scopeId, label, error, retainedData, fromCache });
  }, [scopeId, label, code, message, retainedData, fromCache, error]);
}
