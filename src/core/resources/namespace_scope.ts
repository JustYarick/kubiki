/** `all`, a single name, or a canonical JSON array. API calls always expand arrays first. */
export function namespaceNames(scope: string): string[] | null {  if (!scope || scope === 'all') return null;
  if (!scope.startsWith('[')) return [scope];
  try {
    const values: unknown = JSON.parse(scope);
    return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value && value !== 'all'))].sort() : [];
  } catch { return []; }
}
export function namespaceScope(names: readonly string[] | null): string {
  if (names === null) return 'all';
  const unique = [...new Set(names)].sort();
  return unique.length === 1 ? unique[0] : JSON.stringify(unique);
}
/** Union consumers' scopes without broadening a namespace-only request to all. */
export function mergeNamespaceScopes(left: string | undefined, right: string): string {
  if (left === undefined) return right;
  const a = namespaceNames(left); const b = namespaceNames(right);
  return namespaceScope(a === null || b === null ? null : [...a, ...b]);
}
export function namespaceScopeCovers(loaded: string, requested: string): boolean {
  const available = namespaceNames(loaded); const needed = namespaceNames(requested);
  return available === null || needed !== null && needed.every(name => available.includes(name));
}
export function inNamespaceScope(scope: string, namespace?: string): boolean {
  if (!namespace) return true;
  const names = namespaceNames(scope);
  return names === null || names.includes(namespace);
}
export function namespaceScopeLabel(scope: string): string {
  const names = namespaceNames(scope);
  return names === null ? 'All Namespaces' : !names.length ? 'No namespaces' : names.join(', ');
}
export function defaultNamespace(scope: string): string { return namespaceNames(scope)?.[0] ?? 'default'; }
