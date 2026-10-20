import { useEffect, useState } from 'react';
import { parse } from 'yaml';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { RequestErrorNotice } from '../k8s/RequestErrorNotice';
import { k8s } from '../../providers/k8s_provider';
import { normalizeK8sError, type K8sRequestError } from '../../providers/errors';
import { validateHelmTarget, type HelmChart, type HelmMutation, type HelmRelease, type HelmRepo } from '../../providers/helm_types';
import { useClusterStore } from '../../state/cluster_store';
import { invalidateHelmGraphs } from '../../providers/use_helm_graph';

export type HelmAction = HelmMutation['operation'];
const titles: Record<HelmAction, string> = { install: 'Install Helm release', upgrade: 'Upgrade Helm release', rollback: 'Roll back Helm release', uninstall: 'Uninstall Helm release', repository_set: 'Configure Helm repository', repository_remove: 'Remove Helm repository', repository_update: 'Update Helm repository cache' };
const input = 'w-full rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]';

export function HelmActionDialog({ action, release, repo, onClose, onCompleted }: { action: HelmAction; release?: HelmRelease; repo?: HelmRepo; onClose: () => void; onCompleted: () => void }) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  const [name, setName] = useState(release?.name ?? repo?.name ?? '');
  const [namespace, setNamespace] = useState(release?.namespace ?? (scope === 'all' ? '' : scope));
  const [chart, setChart] = useState(''); const [version, setVersion] = useState('');
  const [values, setValues] = useState('{}\n'); const [url, setUrl] = useState(repo?.url ?? 'https://');
  const [revision, setRevision] = useState(Math.max(1, Number(release?.revision ?? 2) - 1));
  const [hooks, setHooks] = useState(false); const [wait, setWait] = useState(true); const [createNamespace, setCreateNamespace] = useState(false); const [keepHistory, setKeepHistory] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<K8sRequestError | null>(null);
  const [valuesReady, setValuesReady] = useState(action !== 'upgrade'); const [loadEpoch, reload] = useState(0);
  const [charts, setCharts] = useState<HelmChart[]>([]); const [searching, setSearching] = useState(false);
  const releaseAction = ['install', 'upgrade', 'rollback', 'uninstall'].includes(action);
  const chartAction = action === 'install' || action === 'upgrade';
  useEffect(() => {
    if (action !== 'upgrade' || !release || !context) return;
    const controller = new AbortController(); setValuesReady(false); setError(null);
    void k8s.getHelmContent(context, release.namespace, release.name, Number(release.revision), 'values', controller.signal).then(value => {
      if (!controller.signal.aborted) { setValues(value.trim() === 'null' ? '{}\n' : value); setValuesReady(true); }
    }, error => { if (!controller.signal.aborted) setError(normalizeK8sError(error, { operation: 'helm' })); });
    return () => controller.abort();
  }, [action, release, context, loadEpoch]);
  const submit = async () => {
    setError(null);
    try {
      if (releaseAction) validateHelmTarget(context ?? '', namespace, name);
      if (chartAction) {
        if (!chart.trim()) throw new Error('Choose a chart reference or a packaged .tgz path.');
        const parsed = parse(values); if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Values must be a YAML mapping.');
      }
      const target = { context: context ?? '', namespace, name };
      let request: HelmMutation;
      if (action === 'install') request = { operation: action, ...target, chart, chart_version: version || null, values, create_namespace: createNamespace, run_hooks: hooks, wait };
      else if (action === 'upgrade') request = { operation: action, ...target, expected_revision: Number(release!.revision), chart, chart_version: version || null, values, run_hooks: hooks, wait };
      else if (action === 'rollback') request = { operation: action, ...target, expected_revision: Number(release!.revision), revision, run_hooks: hooks, wait };
      else if (action === 'uninstall') request = { operation: action, ...target, expected_revision: Number(release!.revision), keep_history: keepHistory, run_hooks: hooks };
      else if (action === 'repository_set') request = { operation: action, name, url, previous_url: repo?.url ?? null };
      else if (action === 'repository_remove') request = { operation: action, name: repo!.name, expected_url: repo!.url };
      else request = { operation: action, name: repo?.name ?? null };
      setBusy(true); await k8s.mutateHelm(request); invalidateHelmGraphs(); onCompleted(); onClose();
    } catch (error) { setError(normalizeK8sError(error, { operation: 'helm_mutation' })); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title={titles[action]} width={720} footer={<><Button size="sm" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" loading={busy} disabled={busy || !valuesReady || !k8s.supportsHelmMutations} onClick={() => { void submit(); }}>Review in system dialog</Button></>}>
    <div className="space-y-3 text-xs">
      <p className="text-[var(--text-secondary)]">{releaseAction ? `Cluster: ${context ?? 'Select a cluster'}` : 'Local Helm configuration · shared across clusters'}. The backend prepares the change and opens a system confirmation before executing it.</p>
      {!k8s.supportsHelmMutations && <p>Helm changes are available in the desktop app.</p>}
      {releaseAction && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="space-y-1 block"><span>Release name</span><input aria-label="Helm release name" className={input} value={name} disabled={busy || action !== 'install'} onChange={event => setName(event.target.value)} /></label><label className="space-y-1 block"><span>Namespace</span><input aria-label="Helm target namespace" className={input} value={namespace} disabled={busy || action !== 'install'} onChange={event => setNamespace(event.target.value)} /></label></div>}
      {chartAction && <><div className="flex gap-2 items-end"><label className="space-y-1 block flex-1 min-w-0"><span>Chart reference or packaged .tgz path</span><input aria-label="Helm chart reference" className={input} placeholder="repository/chart or oci://registry/chart" value={chart} disabled={busy} onChange={event => setChart(event.target.value)} /></label><Button size="sm" disabled={busy || searching || !chart.trim()} onClick={() => { setSearching(true); setError(null); void k8s.searchHelmCharts(chart).then(setCharts).catch(error => setError(normalizeK8sError(error, { operation: 'helm' }))).finally(() => setSearching(false)); }}>{searching ? 'Searching…' : 'Find charts'}</Button></div>
        {!!charts.length && <div className="max-h-40 overflow-auto border border-[var(--border-default)] rounded">{charts.slice(0, 50).map(entry => <button key={`${entry.name}/${entry.version}`} className="w-full p-2 text-left hover:bg-[var(--bg-hover)] flex justify-between gap-2" onClick={() => { setChart(entry.name); setVersion(entry.version); setCharts([]); }}><span className="truncate">{entry.name}</span><span>{entry.version}</span></button>)}</div>}
        <label className="space-y-1 block"><span>Chart version (empty resolves a version before review)</span><input aria-label="Helm chart version" className={input} value={version} disabled={busy} onChange={event => setVersion(event.target.value)} /></label>
        <label className="space-y-1 block"><span>User values YAML · replaces the supplied overrides</span><textarea aria-label="Helm values YAML" className={`${input} resource-data-value kubiki-scrollbar font-mono min-h-40`} spellCheck={false} autoComplete="off" value={values} disabled={busy || !valuesReady} onChange={event => setValues(event.target.value)} /></label>
        {!valuesReady && <div><p role="status">Loading the current revision values…</p>{error && <Button size="sm" onClick={() => reload(value => value + 1)}>Retry loading values</Button>}</div>}
      </>}
      {action === 'rollback' && <label className="space-y-1 block"><span>Target revision · current revision {release?.revision}</span><input aria-label="Helm rollback revision" type="number" min={1} className={input} value={revision} disabled={busy} onChange={event => setRevision(Number(event.target.value))} /></label>}
      {releaseAction && <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2"><input type="checkbox" checked={hooks} disabled={busy} onChange={event => setHooks(event.target.checked)} />Run chart hooks</label>{action !== 'uninstall' && <label className="flex items-center gap-2"><input type="checkbox" checked={wait} disabled={busy} onChange={event => setWait(event.target.checked)} />Wait for readiness (up to 5 minutes)</label>}{action === 'install' && <label className="flex items-center gap-2"><input type="checkbox" checked={createNamespace} disabled={busy} onChange={event => setCreateNamespace(event.target.checked)} />Create namespace if absent</label>}{action === 'uninstall' && <label className="flex items-center gap-2"><input type="checkbox" checked={keepHistory} disabled={busy} onChange={event => setKeepHistory(event.target.checked)} />Keep release history</label>}</div>}
      {action === 'repository_set' && <><label className="space-y-1 block"><span>Repository name</span><input aria-label="Helm repository name" className={input} value={name} disabled={busy || !!repo} onChange={event => setName(event.target.value)} /></label><label className="space-y-1 block"><span>Repository URL</span><input aria-label="Helm repository URL" className={input} value={url} disabled={busy} onChange={event => setUrl(event.target.value)} /></label></>}
      {action === 'repository_remove' && <p className="break-all">Remove {repo?.name}: {repo?.url}</p>}
      {action === 'repository_update' && <p>Refresh the cached chart index for {repo?.name ?? 'all configured repositories'}.</p>}
      {busy && <p role="status">Preparing the review, waiting for system confirmation or executing the approved operation…</p>}
      {error && <RequestErrorNotice error={error} />}
    </div>
  </Modal>;
}
