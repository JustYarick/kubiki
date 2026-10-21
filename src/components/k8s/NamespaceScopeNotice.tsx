import { inNamespaceScope, namespaceNames, namespaceScope, namespaceScopeLabel } from '../../core/resources/namespace_scope';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { Button } from '../ui/Button';

/** A missing object outside the loaded namespace is not evidence that it was deleted. */
export function NamespaceScopeNotice({ namespace }: { namespace?: string }) {
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const selectNamespace = useClusterStore((s) => s.selectNamespace);
  const watch = useResourceStore((s) => s.syncMode === 'watch');
  if (!watch || selectedNamespace === 'all') return null;
  const outside = namespace && !inNamespaceScope(selectedNamespace, namespace);
  return <div role="status" className="px-3 py-2 text-xs text-[var(--text-secondary)] border-b border-[var(--border-default)] flex flex-wrap items-center gap-2">
    <span>Namespaced data is limited to <strong className="font-mono">{namespaceScopeLabel(selectedNamespace)}</strong>. {outside ? `Namespace ${namespace} is outside the loaded scope.` : 'Cluster resources remain visible; counts and relationships use loaded data only.'}</span>
    {outside && <Button size="sm" onClick={() => selectNamespace(namespaceScope([...(namespaceNames(selectedNamespace) ?? []), namespace]))}>Load namespace {namespace}</Button>}
  </div>;
}
