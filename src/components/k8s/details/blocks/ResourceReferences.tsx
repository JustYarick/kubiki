import { useMemo, useState } from 'react';
import type { ResourceItem } from '../../../../types/k8s';
import { buildResourceGraph } from '../../../../core/resources/relationships';
import { resourceKey } from '../../../../core/resources/identity';
import { useResourceStore } from '../../../../state/resource_store';
import { DetailsSection } from '../DetailsSection';
import { Button } from '../../../ui/Button';

export function ResourceReferences({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const resources = useResourceStore(state => state.resources);
  const [limit, setLimit] = useState(30);
  const targets = useMemo(() => {
    const key = resourceKey(item);
    const graph = buildResourceGraph(resources, { adjacentTo: new Set([key]), includeContains: false, includeMissing: false });
    return [...new Map(graph.relations.filter(edge => edge.source === key).flatMap(edge => { const target = graph.items.get(edge.target); return target ? [[edge.target, target] as const] : []; })).values()];
  }, [resources, item]);
  if (!targets.length) return null;
  return <DetailsSection title="Referenced resources">{targets.slice(0, limit).map(target => <button key={resourceKey(target)} className="details-resource-row details-link break-all" onClick={() => onNavigate(target)}>{target.kind}/{target.name}{target.namespace ? ` · ${target.namespace}` : ''}</button>)}{targets.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 30)}>Show next 30</Button>}</DetailsSection>;
}
