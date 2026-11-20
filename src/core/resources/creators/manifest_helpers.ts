import { isMap, parseDocument, type Document } from 'yaml';
import type { KeyValueEntry } from './types';

export type ParsedManifestResult =
  | { ok: true; object: Record<string, any>; document: Document.Parsed }
  | { ok: false; error: string };

/** Parse a YAML manifest string into a plain Kubernetes object and AST document. */
export function readManifestObject(manifest: string): ParsedManifestResult {
  const document = parseDocument(manifest);
  if (document.errors.length) {
    return { ok: false, error: document.errors[0].message };
  }
  const object = document.toJS({ maxAliasCount: 50 });
  if (!object || Array.isArray(object) || typeof object !== 'object') {
    return { ok: false, error: 'Manifest must contain one YAML object.' };
  }
  return { ok: true, object, document };
}

/** Patch a YAML document in place, preserving comments and unmodeled fields. */
export function patchManifest(manifest: string, mutate: (document: Document) => void): string {
  const document: Document = parseDocument(manifest);
  if (document.errors.length) {
    throw new Error(document.errors[0].message);
  }
  if (!isMap(document.contents)) {
    document.contents = document.createNode({});
  }
  mutate(document);
  return document.toString();
}

/** Ensure every ancestor along `path` is a YAML map before setting a leaf value. */
export function setPath(document: Document, path: (string | number)[], value: unknown): void {
  for (let i = 1; i < path.length; i += 1) {
    const prefix = path.slice(0, i);
    const existing = document.getIn(prefix, true);
    if (!isMap(existing)) {
      document.setIn(prefix, document.createNode({}));
    }
  }
  document.setIn(path, document.createNode(value));
}

/** Safely remove a nested YAML key if its parent chain exists as maps. */
export function deletePath(document: Document, path: (string | number)[]): void {
  for (let i = 1; i < path.length; i += 1) {
    const existing = document.getIn(path.slice(0, i), true);
    if (!isMap(existing)) return;
  }
  document.deleteIn(path);
}

/** Set a trimmed string at `path`, or delete the field when blank. */
export function setOptionalString(document: Document, path: (string | number)[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) setPath(document, path, trimmed);
  else deletePath(document, path);
}

/** Parse a strict integer string, returning `undefined` when empty and `null` when invalid. */
export function parseOptionalInt(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Convert a plain object map of strings into stable UI key-value entries. */
export function readStringEntries(source: unknown): KeyValueEntry[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  return Object.entries(source as Record<string, unknown>).map(([key, value], index) => ({
    id: index + 1,
    key,
    value: value === null || value === undefined ? '' : String(value),
  }));
}

/** Compute a collision-free id for a newly appended row. */
export function nextEntryId(entries: readonly { id: number }[]): number {
  let max = 0;
  for (const entry of entries) {
    if (entry.id > max) max = entry.id;
  }
  return max + 1;
}

/** Build a clean record from key-value rows, skipping rows whose key is blank. */
export function entriesToRecord(entries: readonly KeyValueEntry[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    record[key] = entry.value;
  }
  return record;
}

/** Validate key-value rows for blank keys (when value is present) and duplicates. */
export function validateKeyValueEntries(
  entries: readonly KeyValueEntry[],
  label: string,
  keyPattern?: RegExp,
): string {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      if (entry.value.trim()) return `${label}: every entry with a value must have a key.`;
      continue;
    }
    if (keyPattern && !keyPattern.test(key)) {
      return `${label}: invalid key "${key}".`;
    }
    if (seen.has(key)) {
      return `${label}: duplicate key "${key}".`;
    }
    seen.add(key);
  }
  return '';
}

/** Read metadata.labels or metadata.annotations into stable rows. */
export function readMetadataEntries(object: Record<string, any>, field: 'labels' | 'annotations'): KeyValueEntry[] {
  return readStringEntries(object?.metadata?.[field]);
}

/** Write metadata.labels or metadata.annotations back to the YAML document. */
export function writeMetadataEntries(
  document: Document,
  field: 'labels' | 'annotations',
  entries: readonly KeyValueEntry[],
): void {
  const record = entriesToRecord(entries);
  if (Object.keys(record).length > 0) {
    setPath(document, ['metadata', field], record);
  } else {
    deletePath(document, ['metadata', field]);
  }
}

/** Update labels and annotations directly on a YAML manifest string. */
export function updateManifestMetadataPairs(
  manifest: string,
  labels: readonly KeyValueEntry[],
  annotations: readonly KeyValueEntry[],
): string {
  return patchManifest(manifest, (doc) => {
    writeMetadataEntries(doc, 'labels', labels);
    writeMetadataEntries(doc, 'annotations', annotations);
  });
}

/** Strict Kubernetes data key pattern shared by ConfigMap and Secret keys. */
export const K8S_DATA_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
