import { defaultNamespace } from '../../core/resources/namespace_scope';
import { useEffect, useRef, useState } from 'react';
import { parse } from 'yaml';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { CodeEditor } from '../ui/CodeEditor';
import { RequestErrorNotice } from '../k8s/RequestErrorNotice';
import { k8s } from '../../providers/k8s_provider';
import { normalizeK8sError, type K8sRequestError } from '../../providers/errors';
import { validateHelmTarget, type HelmChart, type HelmMutation, type HelmRelease, type HelmRepo } from '../../providers/helm_types';
import { useClusterStore } from '../../state/cluster_store';
import { invalidateHelmGraphs } from '../../providers/use_helm_graph';

export type HelmAction = HelmMutation['operation'];
const titles: Record<HelmAction, string> = { install: 'Install Helm release', upgrade: 'Upgrade Helm release', rollback: 'Roll back Helm release', uninstall: 'Uninstall Helm release', repository_set: 'Configure Helm repository', repository_remove: 'Remove Helm repository', repository_update: 'Update Helm repository cache' };
const input = 'w-full rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]';

interface HelmActionDialogProps { action: HelmAction; initialRevision?: number; release?: HelmRelease; repo?: HelmRepo; onClose: () => void; onCompleted: () => void }

export function HelmActionDialog(props: HelmActionDialogProps) {
  return props.action === 'uninstall' && props.release
    ? <HelmUninstallConfirmation release={props.release} onClose={props.onClose} onCompleted={props.onCompleted} />
    : <HelmOperationForm {...props} />;
}

/** Uninstall opens its one backend confirmation directly from the release action. */
function HelmUninstallConfirmation({ release, onClose, onCompleted }: { release: HelmRelease; onClose: () => void; onCompleted: () => void }) {
  const [context] = useState(() => useClusterStore.getState().currentContext ?? '');
  const started = useRef(false);
  const [error, setError] = useState<K8sRequestError | null>(null);
  const submit = async () => {
    setError(null);
    try {
      validateHelmTarget(context, release.namespace, release.name);
      await k8s.mutateHelm({ operation: 'uninstall', context, namespace: release.namespace, name: release.name, keep_history: false, run_hooks: false });
      invalidateHelmGraphs(); onCompleted(); onClose();
    } catch (failure) {
      const error = normalizeK8sError(failure, { operation: 'helm_mutation' });
      if (error.code === 'cancelled') onClose();
      else setError(error);
    }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void submit();
  }, []);
  if (!error) return null;
  return <Modal open title="Uninstall Helm release" onClose={onClose} width={480} footer={<><Button onClick={onClose}>Close</Button><Button variant="danger" onClick={() => void submit()}>Try again</Button></>}>
    <p className="text-xs mb-3 break-all">{release.name} · {release.namespace} · {context}</p>
    <RequestErrorNotice error={error} />
  </Modal>;
}

function HelmOperationForm({ action, release, repo, initialRevision, onClose, onCompleted }: HelmActionDialogProps) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  const [name, setName] = useState(release?.name ?? repo?.name ?? '');
  const [namespace, setNamespace] = useState(release?.namespace ?? (scope === 'all' ? '' : defaultNamespace(scope)));
  const [chart, setChart] = useState(''); const [version, setVersion] = useState('');
  const [values, setValues] = useState('{}\n'); const [url, setUrl] = useState(repo?.url ?? 'https://');
  const [revision, setRevision] = useState(initialRevision ?? Math.max(1, Number(release?.revision ?? 2) - 1));
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
      if (action === 'rollback' && (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number(release?.revision))) throw new Error('Choose an earlier positive release revision.');
      if (chartAction) {
        if (!chart.trim()) throw new Error('Choose a chart reference or a packaged .tgz path.');
        const parsed = parse(values); if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Values must be a YAML mapping.');
      }
      const target = { context: context ?? '', namespace, name };
      let request: HelmMutation;
      if (action === 'install') request = { operation: action, ...target, chart, chart_version: version || null, values, create_namespace: createNamespace, run_hooks: hooks, wait };
      else if (action === 'upgrade') request = { operation: action, ...target, expected_revision: Number(release!.revision), chart, chart_version: version || null, values, run_hooks: hooks, wait };
      else if (action === 'rollback') request = { operation: action, ...target, expected_revision: Number(release!.revision), revision, run_hooks: hooks, wait };
      else if (action === 'uninstall') request = { operation: action, ...target, keep_history: keepHistory, run_hooks: hooks };
      else if (action === 'repository_set') request = { operation: action, name, url, previous_url: repo?.url ?? null };
      else if (action === 'repository_remove') request = { operation: action, name: repo!.name, expected_url: repo!.url };
      else request = { operation: action, name: repo?.name ?? null };
      setBusy(true); await k8s.mutateHelm(request);
      invalidateHelmGraphs(); onCompleted(); onClose();
    } catch (error) { setError(normalizeK8sError(error, { operation: 'helm_mutation' })); }
    finally { setBusy(false); }
  };
  return <Modal open={!busy} onClose={() => { if (!busy) onClose(); }} title={titles[action]} width={720} footer={<><Button size="sm" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" variant={action === 'uninstall' || action === 'repository_remove' ? 'danger' : 'primary'} loading={busy} disabled={busy || !valuesReady || !k8s.supportsHelmMutations} onClick={() => { void submit(); }}>Continue</Button></>}>
    <div className="space-y-3 text-xs">
      <p className="text-[var(--text-secondary)]">{releaseAction ? `Cluster: ${context ?? 'Select a cluster'}` : 'Local Helm configuration · shared across clusters'}</p>
      {release && <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 space-y-1">
        <p className="font-mono font-medium break-all">{release.name} <span className="text-[var(--text-secondary)]">· revision {release.revision}</span></p>
        <p className="text-[var(--text-secondary)]">{release.chart} · {release.namespace}</p>
        <p className={action === 'uninstall' ? 'text-[var(--status-danger)]' : 'text-[var(--text-secondary)]'}>{action === 'uninstall' ? 'Remove this release and its managed Kubernetes resources.' : action === 'rollback' ? `Restore revision ${revision} as a new release revision. The current revision remains in history.` : 'Choose a chart version and review its values before upgrading.'}</p>
      </div>}
      {!k8s.supportsHelmMutations && <p>Helm changes are available in the desktop app.</p>}
      {releaseAction && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="space-y-1 block"><span>Release name</span><input aria-label="Helm release name" className={input} value={name} disabled={busy || action !== 'install'} onChange={event => setName(event.target.value)} /></label><label className="space-y-1 block"><span>Namespace</span><input aria-label="Helm target namespace" className={input} value={namespace} disabled={busy || action !== 'install'} onChange={event => setNamespace(event.target.value)} /></label></div>}
      {chartAction && <><div className="flex gap-2 items-end"><label className="space-y-1 block flex-1 min-w-0"><span>Chart reference or packaged .tgz path</span><input aria-label="Helm chart reference" className={input} placeholder="repository/chart or oci://registry/chart" value={chart} disabled={busy} onChange={event => setChart(event.target.value)} /></label><Button size="sm" disabled={busy || searching || !chart.trim()} onClick={() => { setSearching(true); setError(null); void k8s.searchHelmCharts(chart).then(setCharts).catch(error => setError(normalizeK8sError(error, { operation: 'helm' }))).finally(() => setSearching(false)); }}>{searching ? 'Searching…' : 'Find charts'}</Button></div>
        {!!charts.length && <div className="max-h-40 overflow-auto border border-[var(--border-default)] rounded">{charts.slice(0, 50).map(entry => <button key={`${entry.name}/${entry.version}`} className="w-full p-2 text-left hover:bg-[var(--bg-hover)] flex justify-between gap-2" onClick={() => { setChart(entry.name); setVersion(entry.version); setCharts([]); }}><span className="truncate">{entry.name}</span><span>{entry.version}</span></button>)}</div>}
        <label className="space-y-1 block"><span>Chart version (empty selects the latest available)</span><input aria-label="Helm chart version" className={input} value={version} disabled={busy} onChange={event => setVersion(event.target.value)} /></label>
        <div className="space-y-1"><span>User values YAML · replaces the supplied overrides</span><CodeEditor ariaLabel="Helm values YAML" value={values} onChange={setValues} readOnly={busy || !valuesReady} language="yaml" height="min(35vh, 320px)" /></div>
        {!valuesReady && <div><p role="status">Loading the current revision values…</p>{error && <Button size="sm" onClick={() => reload(value => value + 1)}>Retry loading values</Button>}</div>}
      </>}
      {action === 'rollback' && <label className="space-y-1 block"><span>Target revision · current revision {release?.revision}</span><input aria-label="Helm rollback revision" type="number" min={1} className={input} value={revision} disabled={busy} onChange={event => setRevision(Number(event.target.value))} /></label>}
      {releaseAction && <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2"><input type="checkbox" checked={hooks} disabled={busy} onChange={event => setHooks(event.target.checked)} />Run chart hooks</label>{action !== 'uninstall' && <label className="flex items-center gap-2"><input type="checkbox" checked={wait} disabled={busy} onChange={event => setWait(event.target.checked)} />Wait for readiness (up to 5 minutes)</label>}{action === 'install' && <label className="flex items-center gap-2"><input type="checkbox" checked={createNamespace} disabled={busy} onChange={event => setCreateNamespace(event.target.checked)} />Create namespace if absent</label>}{action === 'uninstall' && <label className="flex items-center gap-2"><input type="checkbox" checked={keepHistory} disabled={busy} onChange={event => setKeepHistory(event.target.checked)} />Keep release history</label>}</div>}
      {action === 'repository_set' && <><label className="space-y-1 block"><span>Repository name</span><input aria-label="Helm repository name" className={input} value={name} disabled={busy || !!repo} onChange={event => setName(event.target.value)} /></label><label className="space-y-1 block"><span>Repository URL</span><input aria-label="Helm repository URL" className={input} value={url} disabled={busy} onChange={event => setUrl(event.target.value)} /></label></>}
      {action === 'repository_remove' && <p className="break-all">Remove {repo?.name}: {repo?.url}</p>}
      {action === 'repository_update' && <p>Refresh the cached chart index for {repo?.name ?? 'all configured repositories'}.</p>}
      {busy && <p role="status">Waiting for confirmation or completing the Helm operation…</p>}
      {error && <RequestErrorNotice error={error} />}
    </div>
  </Modal>;
}
