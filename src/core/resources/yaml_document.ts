import { parse, stringify } from 'yaml';

/** Display projections keep server fields out of the editable manifest by default. */
export function cleanYaml(source: string): string {
  try {
    const value = parse(source);
    if (!value || typeof value !== 'object') return source;
    delete value.status;
    if (value.metadata) delete value.metadata.managedFields;
    return stringify(value);
  } catch { return source; }
}

export function restoreServerFields(draft: string, fullSource: string): string {
  const value = parse(draft);
  const full = parse(fullSource);
  if (!value || typeof value !== 'object') throw new Error('The manifest must be a YAML mapping.');
  if (full && typeof full === 'object') {
    if ('status' in full) value.status = full.status;
    if (full.metadata?.managedFields !== undefined) {
      value.metadata ??= {};
      value.metadata.managedFields = full.metadata.managedFields;
    }
  }
  return stringify(value);
}

export function sameYaml(left: string, right: string): boolean {
  if (left === right) return true;
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  try { return JSON.stringify(stable(parse(left))) === JSON.stringify(stable(parse(right))); }
  catch { return false; }
}
