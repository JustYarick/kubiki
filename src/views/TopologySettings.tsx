import { Settings2, RotateCw } from 'lucide-react';
import { FloatingIsland } from '../components/ui/FloatingIsland';
import { NamespaceSelect } from '../components/ui/NamespaceSelect';
import { CheckboxRow } from '../components/ui/Checkbox';
import { Button } from '../components/ui/Button';
import { useUiStore } from '../state/ui_store';
import type { ResourceKind } from '../types/k8s';

export function TopologySettings({ namespace, namespaces, onNamespaceChange, onUseSelection, onChooseScope, focusLabel, onFocus,
  direction, onDirectionChange, depth, onDepthChange, onArrange, onResetRoutes, counts, hiddenKinds, onHiddenKindsChange, onDefaultKinds }: {
  namespace: string; namespaces: string[]; onNamespaceChange: (value: string) => void; onUseSelection: () => void; onChooseScope: () => void;
  focusLabel?: string; onFocus?: () => void; direction: 'RIGHT' | 'DOWN'; onDirectionChange: (value: 'RIGHT' | 'DOWN') => void;
  depth?: number; onDepthChange: (value: number) => void; onArrange: () => void; onResetRoutes: () => void;
  counts: [ResourceKind, number][]; hiddenKinds: ReadonlySet<ResourceKind>; onHiddenKindsChange: (value: Set<ResourceKind>) => void; onDefaultKinds: () => void;
}) {
  const grouping = useUiStore((s) => s.topologyGrouping);
  const setTopologyGrouping = useUiStore((s) => s.setTopologyGrouping);
  const animations = useUiStore((s) => s.topologyAnimations);
  const setTopologyAnimations = useUiStore((s) => s.setTopologyAnimations);
  const performanceMode = useUiStore((s) => s.topologyPerformanceMode);
  const setTopologyPerformanceMode = useUiStore((s) => s.setTopologyPerformanceMode);
  const showMinimap = useUiStore((s) => s.topologyShowMinimap);
  const setTopologyShowMinimap = useUiStore((s) => s.setTopologyShowMinimap);

  return <FloatingIsland label="Diagram settings" title="Diagram settings" icon={Settings2}>
    <div className="topology-settings-fields">
      <label className="topology-setting-field"><span>Namespaces</span><NamespaceSelect label="Diagram namespaces" value={namespace} options={namespaces} onChange={onNamespaceChange} /></label>
      <div className="topology-settings-actions"><button onClick={onUseSelection}>Use global selection</button><button onClick={onChooseScope}>Change scope</button></div>
      {focusLabel && <button className="topology-focus-resource" title={focusLabel} onClick={onFocus}>{focusLabel}</button>}
      <label className="topology-setting-field"><span>Direction</span><select aria-label="Diagram direction" className="ide-select" value={direction} onChange={event => onDirectionChange(event.target.value as 'RIGHT' | 'DOWN')}><option value="RIGHT">Left to right</option><option value="DOWN">Top to bottom</option></select></label>
      <label className="topology-setting-field"><span>Cluster grouping</span><select aria-label="Cluster grouping" className="ide-select" value={grouping} onChange={event => setTopologyGrouping(event.target.value as any)}><option value="namespace">Group by namespace</option><option value="flat">Flat layout (fast)</option></select></label>
      <label className="topology-setting-field"><span>Rendering performance</span><select aria-label="Rendering performance" className="ide-select" value={performanceMode} onChange={event => setTopologyPerformanceMode(event.target.value as any)}><option value="quality">Quality (curves & shadows)</option><option value="balanced">Balanced</option><option value="performance">High performance (low-end PC)</option></select></label>
      <label className="topology-setting-field"><span>Physics & animation</span><select aria-label="Physics and animation" className="ide-select" value={animations ? 'on' : 'off'} onChange={event => setTopologyAnimations(event.target.value === 'on')}><option value="on">Animated edge flow</option><option value="off">Static edges (fast)</option></select></label>
      <label className="topology-setting-field"><span>Canvas minimap</span><select aria-label="Canvas minimap" className="ide-select" value={showMinimap ? 'on' : 'off'} onChange={event => setTopologyShowMinimap(event.target.value === 'on')}><option value="on">Show minimap</option><option value="off">Hide minimap</option></select></label>
      {depth != null && <label className="topology-setting-field"><span>Relationship depth</span><select aria-label="Relationship depth" className="ide-select" value={depth} onChange={event => onDepthChange(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} hop{value > 1 ? 's' : ''}</option>)}</select></label>}
      <div className="topology-settings-actions"><Button size="sm" onClick={onArrange}><RotateCw size="calc(12px * var(--ui-factor))" />Arrange</Button><Button size="sm" onClick={onResetRoutes}>Reset arrows</Button></div>
    </div>
    <section aria-label="Topology resource types" className="topology-types">
      <div className="topology-types-heading"><span>Resource types</span><span className="text-[var(--text-muted)]">{counts.filter(([kind]) => !hiddenKinds.has(kind)).length}/{counts.length}</span></div>
      <div className="topology-settings-actions px-2"><button onClick={() => onHiddenKindsChange(new Set())}>Show all</button><button onClick={() => onHiddenKindsChange(new Set(counts.map(([kind]) => kind)))}>Hide all</button><button title="Restore the default hidden resource types" onClick={onDefaultKinds}>Default</button></div>
      <div className="topology-types-list kubiki-scrollbar">{counts.map(([kind, count]) => <CheckboxRow key={kind} label={kind} trailing={count} aria-label={`Show ${kind}`} checked={!hiddenKinds.has(kind)} onChange={() => {
        const next = new Set(hiddenKinds); if (next.has(kind)) next.delete(kind); else next.add(kind); onHiddenKindsChange(next);
      }} />)}</div>
    </section>
  </FloatingIsland>;
}
