import { Fragment, useMemo, useState } from 'react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { DetailsSection } from '../DetailsSection';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { ServicePortsBlock } from '../blocks/ServicePortsBlock';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { Button } from '../../../ui/Button';

export function ServiceDetails({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const resources = useResourceStore(state => state.resources);
  const errors = useResourceStore(state => state.loadErrors);
  const raw = item.raw ?? {}; const spec = raw.spec ?? item.spec ?? {}; const status = raw.status ?? item.statusRaw ?? {};
  const [limit, setLimit] = useState(30);
  const selector: Record<string, string> = spec.selector ?? {};
  const pods = useMemo(() => Object.keys(selector).length ? [...resources.Pod.values()].filter(pod => pod.namespace === item.namespace && Object.entries(selector).every(([key, value]) => (pod.labels ?? pod.raw?.metadata?.labels ?? {})[key] === value)) : [], [resources.Pod, item.namespace, selector]);
  const slices = useMemo(() => [...resources.EndpointSlice.values()].filter(slice => slice.namespace === item.namespace && (slice.labels ?? slice.raw?.metadata?.labels ?? {})['kubernetes.io/service-name'] === item.name), [resources.EndpointSlice, item.namespace, item.name]);
  const endpoints = [...resources.Endpoints.values()].find(endpoint => endpoint.namespace === item.namespace && endpoint.name === item.name);
  const entries: [string, unknown][] = [
    ['Type', spec.type ?? item.serviceType ?? 'ClusterIP'], ['Cluster IPs', (spec.clusterIPs ?? [spec.clusterIP ?? item.clusterIP]).filter(Boolean).join(', ') || '—'],
    ['Headless', spec.clusterIP === 'None' ? 'Yes' : 'No'], ['External name', spec.externalName], ['External IPs', spec.externalIPs?.join(', ')],
    ['Load balancer', status.loadBalancer?.ingress?.map((entry: any) => entry.ip ?? entry.hostname).join(', ')], ['IP families', spec.ipFamilies?.join(', ')],
    ['External traffic policy', spec.externalTrafficPolicy], ['Internal traffic policy', spec.internalTrafficPolicy], ['Session affinity', spec.sessionAffinity ?? 'None'],
    ['Publish not-ready addresses', spec.publishNotReadyAddresses === true ? 'Yes' : 'No'],
  ];
  return <div className="details-stack">
    <ProblemsBanner item={item} />
    <DetailsSection title="Service summary"><dl className="details-properties">{entries.filter(([, value]) => value != null && value !== '').map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{String(value)}</dd></Fragment>)}</dl></DetailsSection>
    <ServicePortsBlock item={item} />
    <DetailsSection title={`EndpointSlices (${slices.length})`} label="Service endpoints">
      {errors.EndpointSlice && <p role="status" className="text-xs text-[var(--status-warn)]">EndpointSlices unavailable: {errors.EndpointSlice.message}</p>}
      {!slices.length && <p className="text-xs text-[var(--text-muted)]">No EndpointSlices in the loaded snapshot. Selector matches below are not a readiness guarantee.</p>}
      {slices.slice(0, limit).map(slice => {
        const entries: any[] = slice.raw?.endpoints ?? []; const ready = entries.filter(endpoint => endpoint.conditions?.ready === true).length;
        return <div key={slice.uid} className="py-2 border-b border-[var(--border-subtle)]">
          <button className="details-link text-xs" onClick={() => onNavigate(slice)}>{slice.name}</button>
          <p className="text-xs text-[var(--text-muted)]">{ready}/{entries.length} ready · {slice.raw?.addressType ?? '—'} · {(slice.raw?.ports ?? []).map((port: any) => `${port.port ?? '—'}/${port.protocol ?? 'TCP'}`).join(', ')}</p>
          {entries.slice(0, 10).map((endpoint, index) => {
            const ref = endpoint.targetRef;
            const target = ref?.kind === 'Pod' ? ref.uid ? resources.Pod.get(ref.uid) : [...resources.Pod.values()].find(pod => pod.name === ref.name && pod.namespace === (ref.namespace ?? item.namespace)) : undefined;
            return <div key={index} className="text-xs min-w-0 flex flex-wrap gap-2 mt-1"><span className="font-mono break-all">{endpoint.addresses?.join(', ')}</span><span className="text-[var(--text-muted)]">{endpoint.conditions?.ready === true ? 'Ready' : endpoint.conditions?.ready === false ? 'Not ready' : 'Readiness unknown'}{endpoint.conditions?.terminating ? ' · Terminating' : ''}</span>{target && <button className="details-link" onClick={() => onNavigate(target)}>{target.name}</button>}</div>;
          })}
          {entries.length > 10 && <p className="text-xs text-[var(--text-muted)]">Open the slice to inspect all {entries.length} endpoints.</p>}
        </div>;
      })}
      {slices.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 30)}>Show next 30 slices</Button>}
      {endpoints && <button className="details-link text-xs mt-2" onClick={() => onNavigate(endpoints)}>Open legacy Endpoints/{endpoints.name}</button>}
    </DetailsSection>
    <DetailsSection title={`Selector matches (${pods.length})`} label="Target Pods and Selector">
      {!Object.keys(selector).length && <p className="text-xs text-[var(--text-muted)]">No Pod selector. This Service uses an external name or independently managed endpoints.</p>}
      {!!Object.keys(selector).length && <dl className="details-properties">{Object.entries(selector).map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>)}</dl>}
      {pods.slice(0, limit).map(pod => <div key={pod.uid} className="flex min-w-0 gap-2 py-1 text-xs"><button className="details-link min-w-0 flex-1 truncate" title={pod.name} onClick={() => onNavigate(pod)}>{pod.name}</button><span className="text-[var(--text-muted)]">{pod.ip ?? '—'} · {pod.status ?? 'Unknown'}</span></div>)}
      {pods.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 30)}>Show next 30 Pods</Button>}
    </DetailsSection>
    <UsedByList item={item} onNavigate={onNavigate} />
    <ConditionsTable conditions={status.conditions} />
    <MetadataBlock item={item} onNavigate={onNavigate} />
  </div>;
}
