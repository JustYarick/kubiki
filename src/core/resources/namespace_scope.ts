/** `all`, a single name, or a canonical JSON array. API calls always expand arrays first. */
export function namespaceNames(scope: string): string[] | null {
  if (!scope || scope === 'all') return null;
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
