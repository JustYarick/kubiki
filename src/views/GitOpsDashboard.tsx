import { CATEGORY_ICONS } from '../core/resource_icons';
import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleHelp, CirclePause, Clock3, GitBranch, Layers, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { useGitOpsDashboard } from '../providers/use_gitops_dashboard';
import { k8s } from '../providers/k8s_provider';
import { argoHealth, argoSync, deliveryReason, deliveryRevision, deliverySource, deliveryState, deliveryTimestamp, fluxCategory } from '../core/resources/delivery';
import { deliveryActivity } from '../core/resources/delivery_activity';
import { gitOpsReferences, resolveGitOpsReference } from '../core/resources/gitops';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useUiStore } from '../state/ui_store';
import { IconButton } from '../components/ui/Button';
import { deliveryIcons } from '../components/ui/DeliverySummary';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import type { ResourceItem } from '../types/k8s';
import './delivery.css';

const inspect = (item: ResourceItem) => { useResourceStore.getState().selectItem(item);useUiStore.setState({ inspectorCollapsed: false }); };
const time = (at: string) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function GitOpsDashboard({ family }: { family: 'flux' | 'argocd' }) {
  const result = useGitOpsDashboard(family);
  return <Dashboard key={JSON.stringify([family, result.context, result.scope])} family={family} result={result} />;
}
function Dashboard({ family, result }: { family: 'flux' | 'argocd'; result: ReturnType<typeof useGitOpsDashboard> }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sync, setSync] = useState('all');
  const [health, setHealth] = useState('all');
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [activityLimit, setActivityLimit] = useState(15);
  const [issueLimit, setIssueLimit] = useState(8);
  const clusterLoading = useClusterStore(state => state.isLoading);
  const crdError = useResourceStore(state => state.loadErrors.CustomResourceDefinition);
  const name = family === 'flux' ? 'Flux' : 'Argo CD';
  const Icon = CATEGORY_ICONS[family];
  const items = useMemo(() => result.entries.flatMap(entry => entry.items ?? []), [result.entries]);
  const primary = useMemo(() => family === 'argocd' ? items.filter(item => item.kind === 'Application') : items.filter(item => ['kustomizations', 'helmreleases', 'sources'].includes(fluxCategory(item) ?? '')), [items, family]);
  const errors = result.entries.filter(entry => entry.error);
  const available = family === 'argocd' ? result.entries.some(entry => entry.type.kind === 'Application' && entry.items !== undefined) : result.entries.some(entry => entry.items !== undefined);
  const partial = !!errors.length || !!crdError || !!result.error;
  const complete = available && !partial;
  const failed = primary.filter(item => deliveryState(item) === 'attention');
  const suspended = primary.filter(item => deliveryState(item) === 'suspended');
  const progressing = primary.filter(item => deliveryState(item) === 'progressing');
  const unknown = primary.filter(item => deliveryState(item) === 'unknown');
  const needle = query.trim().toLowerCase();
  const matches = (item: ResourceItem) => (!needle || [item.name, item.namespace, item.kind, deliverySource(item), deliveryReason(item), deliveryRevision(item)].some(value => value?.toLowerCase().includes(needle)))
    && (family === 'flux' ? category === 'all' || fluxCategory(item) === category : (sync === 'all' || argoSync(item) === sync) && (health === 'all' || argoHealth(item) === health));
  const problems = [...failed, ...suspended, ...unknown, ...progressing].filter(matches);
  const activity = useMemo(() => deliveryActivity(result.events, items), [result.events, items]);
  const filteredActivity = activity.filter(entry => matches(entry.item) && (!warningsOnly || entry.warning));
  const hasFilter = !!query || category !== 'all' || sync !== 'all' || health !== 'all';
  const clear = () => { setQuery('');setCategory('all');setSync('all');setHealth('all');setIssueLimit(8); };
  const openList = (kind: string) => {
    const definition = result.definitions.find(type => type.kind === kind);
    if (definition) useWorkspaceStore.getState().openResourceList(definition.key);
  };
  const summaryText = !result.definitions.length ? 'Resource discovery' : !available ? result.loading ? 'Loading resources…' : 'Resource data unavailable' : partial ? 'Some resource data is unavailable or stale' : failed.length ? `${failed.length} resource${failed.length === 1 ? '' : 's'} need attention` : unknown.length ? `${unknown.length} resource${unknown.length === 1 ? '' : 's'} with unknown state` : progressing.length ? `${progressing.length} reconciliation${progressing.length === 1 ? '' : 's'} in progress` : suspended.length ? `${suspended.length} resource${suspended.length === 1 ? '' : 's'} paused` : !primary.length ? `No ${family === 'flux' ? 'reconciliation resources' : 'applications'} in this scope` : family === 'flux' ? 'All observed resources are reconciled' : 'All observed applications are healthy and synced';
  if (!result.context) return <p className="p-6 text-[var(--text-secondary)]">Select a cluster to view {name}.</p>;
  return <section data-testid={`${family}-dashboard`} aria-label={`${name} overview`} aria-busy={result.loading && !available} className="delivery-page kubiki-scrollbar">
    <div className="delivery-health-strip" data-tone={failed.length ? 'attention' : !available || partial || unknown.length ? 'unknown' : progressing.length ? 'progressing' : suspended.length ? 'suspended' : 'healthy'}>
      <span className="delivery-health-message">{failed.length || partial ? <TriangleAlert size={15} aria-hidden="true" /> : !complete || unknown.length ? <CircleHelp size={15} aria-hidden="true" /> : progressing.length ? <Clock3 size={15} aria-hidden="true" /> : suspended.length ? <CirclePause size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}{summaryText}</span>
      <div className="delivery-refresh"><span>{k8s.demo ? 'Demo · ' : ''}{result.updated ? `Updated ${new Date(result.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · auto 15s` : 'Auto refresh · 15s'}</span><IconButton icon={RefreshCw} size="sm" aria-label={`Refresh ${name} overview`} tooltip="Refresh overview" disabled={result.loading} onClick={result.refresh} /></div>
    </div>
    {crdError && <RequestErrorNotice error={crdError} />}
    {result.error && <RequestErrorNotice error={result.error} retainedData={available} onRetry={result.refresh} />}
    {!!errors.length && <details className="delivery-notice"><summary>Partial or stale data · {errors.length} resource type{errors.length === 1 ? '' : 's'} unavailable</summary>{errors.map(entry => <div key={entry.type.key}><strong>{entry.type.kind}</strong><RequestErrorNotice error={entry.error!} retainedData={entry.items !== undefined} onRetry={result.refresh} /></div>)}</details>}
    {family === 'flux' ? <div className="delivery-kind-cards" role="group" aria-label="Flux reconciliation groups">{([
      ['kustomizations', 'Kustomizations', 'Kustomization', Layers], ['helmreleases', 'HelmReleases', 'HelmRelease', Layers], ['sources', 'Sources', 'GitRepository', GitBranch],
    ] as const).map(([id, label, , CardIcon]) => {
      const entries = result.entries.filter(entry => fluxCategory({ kind: entry.type.kind, apiVersion: `${entry.type.group}/${entry.type.version}` }) === id);
      const group = entries.flatMap(entry => entry.items ?? []);
      const known = entries.length > 0 && entries.every(entry => entry.items !== undefined && !entry.error);
      const ready = group.filter(item => deliveryState(item) === 'healthy').length;
      return <button key={id} className="delivery-kind-card" aria-label={`${label}: ${known ? `${ready} of ${group.length} ready` : 'unavailable'}`} aria-pressed={category === id} onClick={() => { setCategory(previous => previous === id ? 'all' : id);setIssueLimit(8); }}><span className="delivery-card-label"><CardIcon size={15} aria-hidden="true" />{label}</span><span className="delivery-card-ratio">{known ? ready : '—'}<small>{known ? `/ ${group.length} ready` : entries.length ? 'Data unavailable' : 'Not discovered'}</small></span><span className="delivery-card-detail">{group.filter(item => deliveryState(item) === 'attention').length ? `${group.filter(item => deliveryState(item) === 'attention').length} need attention` : known ? group.some(item => deliveryState(item) === 'suspended') ? 'Includes paused resources' : 'Reconciliation status' : 'Awaiting a complete snapshot'}<ArrowRight size={12} aria-hidden="true" /></span></button>;
    })}</div> : <>
      <div className="delivery-argo-summary">
        <button className="delivery-application-count" onClick={() => openList('Application')}><Layers size={16} aria-hidden="true" /><strong>{available ? primary.length : '—'}</strong><span>Applications</span><ArrowRight size={13} aria-hidden="true" /></button>
        <StatusAxis label="Sync" value={sync} values={['Synced', 'OutOfSync', 'Unknown']} items={primary} available={available} read={argoSync} onChange={setSync} />
        <StatusAxis label="Health" value={health} values={['Healthy', 'Progressing', 'Degraded', 'Missing', 'Suspended', 'Unknown']} items={primary} available={available} read={argoHealth} onChange={setHealth} />
      </div>
    </>}
    <div className="delivery-links" aria-label={`${name} resource lists`}>{(family === 'flux' ? ['Kustomization', 'HelmRelease', 'GitRepository', 'OCIRepository', 'ImagePolicy'] : ['Application', 'ApplicationSet', 'AppProject']).filter(kind => result.definitions.some(type => type.kind === kind)).map(kind => <button key={kind} onClick={() => openList(kind)}>{kind === 'AppProject' ? 'Projects' : kind === 'ApplicationSet' ? 'Application sets' : kind}<ArrowRight size={11} aria-hidden="true" /></button>)}</div>
    {!result.definitions.length ? <div className="delivery-empty"><Icon size={28} aria-hidden="true" /><h3>{clusterLoading ? 'Discovering resource types…' : `No ${name} resource types discovered`}</h3><p>Install its CRDs or check your discovery permissions.</p></div> : result.loading && !available ? <ResourceLoading label={`Loading ${name} resources…`} /> : <>
      <div className="delivery-dashboard-filter"><label className="delivery-search"><Search size={14} aria-hidden="true" /><input aria-label={`Search ${name} resources`} placeholder="Filter problems and activity…" value={query} onChange={event => { setQuery(event.target.value);setIssueLimit(8);setActivityLimit(15); }} /></label>{hasFilter && <IconButton icon={X} aria-label="Clear dashboard filters" tooltip="Clear filters" onClick={clear} />}</div>
      <div className="delivery-dashboard-grid">
        <section className="delivery-panel" aria-label={`${name} needs attention`}><header><h2>Needs attention</h2><span>{problems.length}</span></header><div className="delivery-issues kubiki-scrollbar">
          {!problems.length && <div className="delivery-panel-empty">{!available ? 'Resource data unavailable.' : partial ? 'No issues in the available data. Some resources could not be checked.' : hasFilter ? 'No issues match these filters.' : 'No reconciliation issues detected.'}</div>}
          {problems.slice(0, issueLimit).map(item => {
            const state = deliveryState(item);const StateIcon = deliveryIcons[state];const stamp = deliveryTimestamp(item);
            const dependency = gitOpsReferences(item).sources.map(ref => resolveGitOpsReference(ref, items)).find(Boolean);
            return <article key={`${item.apiVersion}/${item.uid}`} className="delivery-issue" data-tone={state}><button className="delivery-issue-target" aria-label={`Inspect ${item.kind} ${item.name} in ${item.namespace ?? 'cluster'}`} onClick={() => inspect(item)}><StateIcon size={14} aria-hidden="true" /><span className="font-mono">{item.name}</span><ArrowRight size={12} aria-hidden="true" /></button><div className="delivery-resource-meta"><ResourceKindBadge kind={item.kind} apiVersion={item.apiVersion} /><span>{item.namespace}</span>{family === 'argocd' && <><span>{argoSync(item)}</span><span>{argoHealth(item)}</span></>}</div><p className="delivery-issue-reason">{deliveryReason(item)}</p><div className="delivery-issue-footnote">{stamp && <time dateTime={stamp.at} title={`${stamp.label}: ${time(stamp.at)}`}>{stamp.label} · {time(stamp.at)}</time>}{dependency ? <button onClick={() => inspect(dependency)}>{dependency.kind === 'AppProject' ? 'Project' : 'Source'}: {dependency.name}<ArrowRight size={10} aria-hidden="true" /></button> : deliverySource(item) !== '—' && <span title={deliverySource(item)}>{deliverySource(item)}</span>}</div>{family === 'argocd' && <p className="delivery-operation">{item.raw?.status?.operationState?.phase ?? 'No sync operation reported'}{deliveryRevision(item) !== '—' ? ` · ${deliveryRevision(item).slice(0, 20)}` : ''} · {item.raw?.spec?.destination?.namespace ?? 'Destination not reported'}</p>}</article>;
          })}
          {problems.length > issueLimit && <button className="delivery-show-more" onClick={() => setIssueLimit(value => value + 12)}>Show next 12</button>}
        </div></section>
        <section className="delivery-panel" aria-label={`${name} recent activity`}><header><h2><Clock3 size={14} aria-hidden="true" />Recent activity</h2><button className="delivery-warning-filter" aria-pressed={warningsOnly} onClick={() => { setWarningsOnly(value => !value);setActivityLimit(15); }}>Warnings{activity.some(entry => entry.warning) ? ` ${activity.filter(entry => entry.warning).length}` : ''}</button></header>
          {result.eventError && <div className="delivery-activity-error"><RequestErrorNotice error={result.eventError} retainedData={!!result.events.length} onRetry={result.refresh} /></div>}
          <div className="delivery-activity kubiki-scrollbar">{!filteredActivity.length && <div className="delivery-panel-empty">{result.eventError ? 'Controller events could not be checked.' : 'No controller events in this scope. Kubernetes events have limited retention.'}</div>}{filteredActivity.slice(0, activityLimit).map(entry => <button key={entry.event.uid} className="delivery-event" aria-label={`Inspect event ${entry.reason} for ${entry.item.name}`} onClick={() => inspect(entry.item)}><span className={`delivery-event-dot ${entry.warning ? 'is-warning' : ''}`} aria-hidden="true" /><span className="delivery-event-content"><strong>{entry.reason}</strong><span className="delivery-event-resource">{entry.item.kind} · {entry.item.namespace}/{entry.item.name}</span><span className="delivery-event-message">{entry.message || 'No event message.'}</span></span><span className="delivery-event-time">{entry.timestamp ? <time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : 'Time unknown'}{entry.count > 1 && <small>×{entry.count}</small>}</span></button>)}{filteredActivity.length > activityLimit && <button className="delivery-show-more" onClick={() => setActivityLimit(value => value + 20)}>Show next 20</button>}</div>
        </section>
      </div>
    </>}
  </section>;
}
function StatusAxis({ label, value, values, items, available, read, onChange }: { label: string; value: string; values: string[]; items: ResourceItem[]; available: boolean; read: (item: ResourceItem) => string; onChange: (value: string) => void }) {
  return <div className="delivery-status-axis" role="group" aria-label={`Application ${label.toLowerCase()}`}><span>{label}</span><div>{values.map(status => <button key={status} aria-label={`${label} ${status}: ${available ? items.filter(item => read(item) === status).length : 'unavailable'}`} aria-pressed={value === status} data-status={status} onClick={() => onChange(value === status ? 'all' : status)}>{status === 'OutOfSync' ? 'Out of sync' : status}<b>{available ? items.filter(item => read(item) === status).length : '—'}</b></button>)}</div></div>;
}
