import type { ResourceQuery, ResourceRef } from '../core/resources/resource_types.ts';

export const ERROR_CODES = ['unauthorized', 'forbidden', 'not_found', 'conflict', 'timeout', 'rate_limited', 'unavailable', 'invalid_request', 'unsupported', 'bridge_unavailable', 'internal'] as const;
export type K8sErrorCode = typeof ERROR_CODES[number];
export interface RequestInfo { operation: string; context?: string; resource?: ResourceQuery | ResourceRef }
export interface K8sErrorPayload extends RequestInfo { code: K8sErrorCode; message: string; status?: number; retryable: boolean }

export class K8sRequestError extends Error implements K8sErrorPayload {
  readonly code: K8sErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly operation: string;
  readonly context?: string;
  readonly resource?: ResourceQuery | ResourceRef;
  constructor(payload: K8sErrorPayload) {
    super(payload.message);
    this.name = 'K8sRequestError';
    this.code = payload.code; this.status = payload.status; this.retryable = payload.retryable;
    this.operation = payload.operation; this.context = payload.context; this.resource = payload.resource;
  }
}

export function requestError(code: K8sErrorCode, message: string, info: RequestInfo, status?: number): K8sRequestError {
  return new K8sRequestError({ ...info, code, message, status, retryable: ['timeout', 'rate_limited', 'unavailable', 'bridge_unavailable'].includes(code) });
}

export function codeForStatus(status: number): K8sErrorCode {
  switch (status) {
    case 400: case 422: return 'invalid_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 408: case 504: return 'timeout';
    case 429: return 'rate_limited';
    case 502: case 503: return 'unavailable';
    default: return 'internal';
  }
}

/** Both Tauri rejections and the HTTP bridge use this envelope. Legacy strings remain readable. */
export function normalizeK8sError(error: unknown, info: RequestInfo = { operation: 'unknown' }, status?: number): K8sRequestError {
  if (error instanceof K8sRequestError) return error;
  let value = error;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* Legacy IPC string. */ } }
  if (value && typeof value === 'object' && 'error' in value) value = value.error;
  if (value && typeof value === 'object' && 'code' in value && 'message' in value && ERROR_CODES.includes(value.code as K8sErrorCode) && typeof value.message === 'string') {
    const payload = value as K8sErrorPayload;
    // Request identity is owned by the caller, never replaced by a stale transport payload.
    return requestError(payload.code, payload.message, info, payload.status ?? status);
  }
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : 'Kubernetes request failed';
  return requestError(status ? codeForStatus(status) : 'internal', message, info, status);
}

/** kubectl emits plain stderr. Only recognized server reasons and transport failures are classified. */
export function kubectlError(error: unknown, info: RequestInfo): K8sRequestError {
  const failure = error as { stderr?: string; message?: string; code?: string; killed?: boolean };
  const message = (failure?.stderr || failure?.message || String(error)).trim();
  if (failure?.killed || /deadline exceeded|i\/o timeout|request timed out|timed out waiting/i.test(message)) return requestError('timeout', message, info, 504);
  if (failure?.code === 'ENOENT') return requestError('bridge_unavailable', 'kubectl is not installed or is not available in PATH.', info, 503);
  const reason = /(?:Error from server|error from server) \(([^)]+)\)/.exec(message)?.[1];
  const statuses: Record<string, number> = { Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409, AlreadyExists: 409, BadRequest: 400, Invalid: 422, Timeout: 504, ServerTimeout: 504, TooManyRequests: 429, ServiceUnavailable: 503 };
  if (reason && statuses[reason]) return requestError(codeForStatus(statuses[reason]), message, info, statuses[reason]);
  if (/connection refused|unable to connect to the server|no such host|network is unreachable/i.test(message)) return requestError('unavailable', message, info, 503);
  return requestError('internal', message, info, 500);
}

export function errorHint(error: K8sRequestError): string {
  switch (error.code) {
    case 'forbidden': return 'Access denied. Check RBAC permissions for this resource and namespace.';
    case 'unauthorized': return 'Authentication required. Refresh your credentials or check the selected context.';
    case 'not_found': return 'The resource or API endpoint no longer exists. Refresh the list.';
    case 'conflict': return 'The resource changed. Refresh it before trying again.';
    case 'timeout': return 'The request timed out. Check the connection and try again.';
    case 'rate_limited': return 'The API server is limiting requests. Wait before retrying.';
    case 'unavailable': return 'The API server is unavailable. Check the connection and selected context.';
    case 'bridge_unavailable': return 'Start the desktop app or development bridge and check that kubectl is installed.';
    case 'unsupported': return 'This resource type or API version is not supported yet.';
    default: return '';
  }
}
