import { defaultNamespace } from '../../core/resources/namespace_scope';
import { useEffect, useRef, useState } from 'react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import type { DockSession } from '../../state/dock_store';
import type { ResourceRef } from '../../core/resources/resource_types';
import { isValidNamespaceName, resourceQuery } from '../../core/resources/resource_types';
import { prepareNodeDebug, stopNodeDebug, nodeDebugStatus, otherDebugPods, removeOtherDebugPod, type NodeDebugResult, type NodeDebugState, type DebugPod } from '../../providers/node_debug';
import { normalizeK8sError } from '../../providers/errors';
import { LiveTerminalPane } from './LiveTerminalPane';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export function NodeShellPane({ session, visible }: { session: DockSession; visible: boolean }) {
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const currentContext = useClusterStore((s) => s.currentContext);
  const nodes = useResourceStore((s) => s.resources.Node);
  const context = session.context ?? currentContext;
  const node = currentContext === context ? [...nodes.values()].find((node) => node.name === session.resourceName) : undefined;
  const uid = session.uid ?? node?.uid;
  const recreated = Boolean(session.uid && node && session.uid !== node.uid);
  const nodeRef: ResourceRef | undefined = context && session.resourceName && uid ? { ...resourceQuery(context, 'Node'), name: session.resourceName, uid } : undefined;
  const [namespace, setNamespace] = useState(defaultNamespace(selectedNamespace));
  const [image, setImage] = useState('docker.io/library/ubuntu:24.04');
  const [showConfig, setShowConfig] = useState(false);
  const [shell, setShell] = useState('/bin/sh');
  const [activeShell, setActiveShell] = useState('/bin/sh');
  const [result, setResult] = useState<NodeDebugResult>();
  const [phase, setPhase] = useState('starting');
  const [status, setStatus] = useState<NodeDebugState | null>(null);
  const [error, setError] = useState('');
  const [others, setOthers] = useState<DebugPod[]>([]);
  const [listing, setListing] = useState(false);
  const prepareAbort = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const started = useRef('');
  const liveRuns = useRef(0);
  const native = '__TAURI_INTERNALS__' in window;
  const busy = phase === 'preparing' || phase === 'closing' || phase === 'starting';
  const fail = (error: unknown) => normalizeK8sError(error, { operation: 'node_debug' }).message;
  useEffect(() => {
    mounted.current = true;
    // StrictMode replays mount effects: cancelling immediately would abort the
    // in-flight preparation, so the abort waits a tick and only fires when no
    // mount effect is alive (a real unmount).
    return () => { mounted.current = false;setTimeout(() => { if (liveRuns.current < 1) prepareAbort.current?.abort(); }, 0); };
  }, []);
  // A shell tab provisions and connects on its own; nothing is created in demo
  // or browser mode, and handling the create consent is the only dialog.
  useEffect(() => {
    if (!native || !nodeRef || recreated) return;
    liveRuns.current++;
    if (started.current !== nodeRef.uid) { started.current = nodeRef.uid ?? '';void start(); }
    return () => { liveRuns.current--; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeRef?.context, nodeRef?.uid, nodeRef?.name]);
  // Optional live status of the helper Pod for the header caption.
  useEffect(() => {
    if (!native || !result) return;
    let cancelled = false;let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await nodeDebugStatus(result.session_id);
        if (!cancelled) {
          setStatus(state);
          if (!state) { setResult(undefined); setPhase((current) => current === 'ready' ? 'closed' : current); }
          else if (state.phase === 'cleanup_failed') setError(state.error?.message ?? state.detail);
        }
      } catch (pollError) { if (!cancelled) setError(fail(pollError)); }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    void poll();return () => { cancelled = true;clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, result?.session_id]);
  async function start(nextShell = shell, nextNamespace = namespace, nextImage = image) {
    if (!native || !nodeRef) return;
    setError('');setPhase('preparing');setResult(undefined);setStatus(null);
    setActiveShell(nextShell);
    const abort = new AbortController();prepareAbort.current = abort;
    try {
      const prepared = await prepareNodeDebug({ resource: nodeRef, namespace: nextNamespace, image: nextImage }, abort.signal);
      if (!mounted.current || abort.signal.aborted) return;
      setResult(prepared);setPhase('ready');
    } catch (startError) { if (mounted.current && !abort.signal.aborted) { setError(fail(startError));setPhase('failed'); } }
    finally { if (prepareAbort.current === abort) prepareAbort.current = undefined; }
  }
  /** End session: every shell on this Node stops and the helper Pod is deleted. */
  async function endSession() {
    if (!result) return;
    setPhase('closing');prepareAbort.current?.abort();
    try {
      await stopNodeDebug(result.session_id);
      if (mounted.current) { setError('');setPhase('closed');setStatus(null);setResult(undefined);setOthers([]); }
    }
    catch (endError) { if (mounted.current) { setError(fail(endError));setPhase('cleanup_failed'); } }
  }
  /** Apply configuration: the old helper Pod is deleted and a new one is created. */
  async function recreate() {
    if (!isValidNamespaceName(namespace) || !image.trim()) return;
    setPhase('closing');
    if (result) await stopNodeDebug(result.session_id).catch(() => {});
    if (!mounted.current) return;
    await start(shell, namespace, image);
  }
  async function loadOthers() {
    if (!context || !isValidNamespaceName(namespace)) return;
    setListing(true);setError('');
    try { const pods = await otherDebugPods(context, namespace);if (mounted.current) setOthers(pods); }
    catch (listError) { if (mounted.current) setError(fail(listError)); }
    finally { if (mounted.current) setListing(false); }
  }
  const terminalSession: DockSession | undefined = result ? { ...session, targetType: 'pod', uid: result.pod.uid ?? undefined, context: result.pod.context, kind: 'Pod', resourceName: result.pod.name, namespace: result.pod.namespace ?? undefined, container: 'debugger', allContainers: ['debugger'] } : undefined;
  const clamped = !isValidNamespaceName(namespace);
  return <div className="h-full flex flex-col min-h-0 min-w-0" data-testid="node-shell">
    <div className="shrink-0 px-3 py-2 space-y-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong className="font-mono break-all">Node: {session.resourceName}</strong>
        <span className="text-[var(--text-muted)]">{context} · {status?.phase ?? phase}{status?.detail ? ` · ${status.detail}` : result?.reused ? ' · reused helper Pod' : ''}</span>
        {(phase === 'failed' || phase === 'closed' || phase === 'cleanup_failed') && native && <Button size="sm" onClick={() => void start()}>Reconnect</Button>}
        {status?.phase === 'cleanup_failed' && <Button size="sm" onClick={() => void endSession()}>Retry cleanup</Button>}
        {result && <Button size="sm" onClick={() => void endSession()}>End session</Button>}
        <Button size="sm" onClick={() => setShowConfig((show) => !show)}>{showConfig ? 'Hide options' : 'Options'}</Button>
      </div>
      {result && <p className="font-mono text-xs text-[var(--text-muted)] break-all">Helper Pod: {result.pod.namespace ?? status?.namespace}/{result.pod.name ?? status?.name} · closes automatically with the last shell</p>}
      {error && <p role="alert" className="text-xs text-[var(--status-danger)] break-words">{error}</p>}
      {(!native || !uid || recreated) && <p className="text-xs text-[var(--status-warn)]">{!native ? 'Node shell is available in the desktop app.' : 'Reopen the current Node before starting a shell.'}</p>}
      {showConfig && <section aria-label="Node shell options" className="rounded border border-[var(--border-default)] p-2 space-y-2 text-xs">
        <p className="text-[var(--text-secondary)]">A root helper Pod (privileged, host PID/IPC/network, /host mount) is created once per Node and reused by every shell on it. Leaving the last shell deletes it automatically — the Node stays clean without extra confirmations.</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-[1_1_140px]">Pod namespace<Input aria-label="Debug Pod namespace" value={namespace} onChange={(e) => { setNamespace(e.target.value);setOthers([]); }} disabled={busy} invalid={clamped} /></label>
          <label className="min-w-0 flex-[2_1_220px]">Debug image<Input aria-label="Debug image" value={image} onChange={(e) => setImage(e.target.value)} disabled={busy} /></label>
          <label className="max-w-[140px]">Shell binary<select aria-label="Node shell binary" className="ide-select block max-w-full" value={shell} onChange={(e) => setShell(e.target.value)} disabled={busy}>{['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh'].map((value) => <option key={value}>{value}</option>)}</select></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!native || !nodeRef || busy || recreated || clamped || !image.trim()} onClick={() => void recreate()}>Apply (recreate helper Pod)</Button>
          <Button size="sm" disabled={!native || !context || listing || busy || clamped} onClick={() => void loadOthers()}>Other debug Pods</Button>
        </div>
        {!!others.length && <div className="space-y-2" aria-label="Other Kubiki debug Pods">
          <p className="text-[var(--text-muted)]">These Pods have no active session in this Kubiki process. Check that another Kubiki instance is not using a Pod before deleting it.</p>
          {others.map((pod) => <div key={pod.resource.uid} className="flex items-center flex-wrap gap-2"><span className="font-mono flex-1 break-all">{pod.resource.name} · {pod.node} · {pod.phase}</span><Button size="sm" aria-label={`Delete debug Pod ${pod.resource.name}`} onClick={() => { void removeOtherDebugPod(pod.resource).then(() => setOthers((items) => items.filter((item) => item.resource.uid !== pod.resource.uid))).catch((cleanError) => setError(fail(cleanError))); }}>Delete</Button></div>)}
        </div>}
      </section>}
    </div>
    {terminalSession && result && <div className="flex-1 min-h-0"><LiveTerminalPane key={result.pod.uid} session={terminalSession} visible={visible} nodeDebug={{ sessionId: result.session_id, node: session.resourceName ?? '', resource: nodeRef!, shell: activeShell }} /></div>}
  </div>;
}
