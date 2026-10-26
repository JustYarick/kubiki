import { requestError } from './errors.ts';
import { isValidNamespaceName } from '../core/resources/resource_types.ts';

export type HelmSection = 'releases' | 'repositories';
export type HelmDocument = 'values' | 'manifest' | 'notes' | 'hooks';
export interface HelmRelease { name: string; namespace: string; revision: string; updated: string; status: string; chart: string; app_version: string }
export interface HelmHistory { revision: number; updated: string; status: string; chart: string; app_version: string; description: string }
export interface HelmRepo { name: string; url: string }
export interface HelmChart { name: string; version: string; app_version: string; description: string }
type ReleaseTarget = { context: string; namespace: string; name: string };
export type HelmMutation =
  | (ReleaseTarget & { operation: 'install'; chart: string; chart_version: string | null; values: string; create_namespace: boolean; run_hooks: boolean; wait: boolean })
  | (ReleaseTarget & { operation: 'upgrade'; expected_revision: number; chart: string; chart_version: string | null; values: string; run_hooks: boolean; wait: boolean })
  | (ReleaseTarget & { operation: 'rollback'; expected_revision: number; revision: number; run_hooks: boolean; wait: boolean })
  | (ReleaseTarget & { operation: 'uninstall'; expected_revision: number; keep_history: boolean; run_hooks: boolean })
  | { operation: 'repository_set'; name: string; url: string; previous_url: string | null }
  | { operation: 'repository_remove'; name: string; expected_url: string }
  | { operation: 'repository_update'; name: string | null };
export interface HelmReleasePage { context: string; namespace: string | null; offset: number; limit: number; has_more: boolean; items: HelmRelease[] }
export const HELM_PAGE_SIZE = 100;

export function validateHelmTarget(context: string, namespace?: string | null, name?: string): void {
  const invalid = (message: string) => requestError('invalid_request', message, { operation: 'helm', context }, 400);
  if (!context.trim() || context.length > 4096 || /[\x00-\x1f\x7f]/.test(context)) throw invalid('A valid Kubernetes context is required');
  if (namespace != null && !isValidNamespaceName(namespace)) throw invalid('Invalid Helm namespace');
  if (name !== undefined && (!namespace || name.length > 53 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || name.split('.').some(part => !part || part.startsWith('-') || part.endsWith('-')))) throw invalid('Invalid Helm release name or namespace');
}

export function validateHelmOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw requestError('invalid_request', 'Invalid release offset', { operation: 'helm' }, 400);
}

export function validateHelmDocument(document: string, revision: number): asserts document is HelmDocument {
  if (!['values', 'manifest', 'notes', 'hooks'].includes(document) || !Number.isSafeInteger(revision) || revision <= 0 || revision > 4294967295) throw requestError('invalid_request', 'A supported document and positive release revision are required', { operation: 'helm' }, 400);
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const failure = () => requestError('internal', 'Helm returned an invalid response', { operation: 'helm' }, 500);

export function parseHelmReleases(data: unknown): HelmRelease[] {
  if (!Array.isArray(data) || data.some(item => !object(item) || !strings(item, ['name', 'namespace', 'revision', 'updated', 'status', 'chart', 'app_version']) || !/^[1-9]\d*$/.test(item.revision as string) || !Number.isSafeInteger(Number(item.revision)) || Number(item.revision) > 4294967295)) throw failure();
  return data as HelmRelease[];
}

export function parseHelmPage(data: unknown, context: string, namespace: string | null, offset: number): HelmReleasePage {
  if (!object(data) || data.context !== context || data.namespace !== namespace || data.offset !== offset || data.limit !== HELM_PAGE_SIZE || typeof data.has_more !== 'boolean') throw failure();
  const items = parseHelmReleases(data.items);
  if (items.length > HELM_PAGE_SIZE || namespace && items.some(item => item.namespace !== namespace)) throw failure();
  return data as unknown as HelmReleasePage;
}

export function parseHelmHistory(data: unknown): HelmHistory[] {
  if (!Array.isArray(data) || data.some(item => !object(item) || !Number.isSafeInteger(item.revision) || Number(item.revision) <= 0 || Number(item.revision) > 4294967295 || !strings(item, ['updated', 'status', 'chart', 'app_version', 'description']))) throw failure();
  return data as HelmHistory[];
}

export function parseHelmRepositories(data: unknown): HelmRepo[] {
  if (!Array.isArray(data) || data.some(item => !object(item) || !strings(item, ['name', 'url']))) throw failure();
  return data as HelmRepo[];
}

export function helmStatusTone(status: string): string {
  if (status === 'deployed') return 'text-[var(--status-ok)]';
  if (status === 'failed') return 'text-[var(--status-danger)]';
  if (status.startsWith('pending-') || status === 'uninstalling') return 'text-[var(--status-warn)]';
  return 'text-[var(--text-secondary)]';
}

/** Helm's Go timestamp includes a timezone name and sometimes nanoseconds. */
export function helmUpdatedAt(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-]\d{4})(?: \S+)?$/.exec(value);
  const iso = match ? `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}${match[4].slice(0, 3)}:${match[4].slice(3)}` : value;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}
