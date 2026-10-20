import { useEffect, useRef, useState } from 'react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import type { DockSession } from '../../state/dock_store';
import type { ResourceRef } from '../../core/resources/resource_types';
import { isValidNamespaceName, resourceQuery } from '../../core/resources/resource_types';
import { prepareNodeDebug, stopNodeDebug, nodeDebugStatus, otherDebugPods, removeOtherDebugPod, type NodeDebugState, type DebugPod } from '../../providers/node_debug';
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
  const [namespace, setNamespace] = useState(selectedNamespace === 'all' ? 'default' : selectedNamespace);
  const [image, setImage] = useState('docker.io/library/ubuntu:24.04');
  const [showSetup, setShowSetup] = useState(true);
  const [shell, setShell] = useState('/bin/sh');
  const [resource, setResource] = useState<ResourceRef>();
  const [id, setId] = useState('');
  const [phase, setPhase] = useState('idle');
  const [status, setStatus] = useState<NodeDebugState | null>(null);
  const [error, setError] = useState('');
  const [others, setOthers] = useState<DebugPod[]>([]);
  const [listing, setListing] = useState(false);
  const active = useRef<{ id: string; abort: AbortController } | undefined>(undefined);
  const mounted = useRef(true);
  const autoStarted = useRef(false);
  const native = '__TAURI_INTERNALS__' in window;
  const busy = phase === 'preparing' || phase === 'closing';
  const fail = (error: unknown) => normalizeK8sError(error, { operation: 'node_debug' }).message;
  useEffect(() => { mounted.current = true;return () => { mounted.current = false;active.current?.abort.abort(); }; }, []);
  useEffect(() => {
    if (!native || !id) return;
    let cancelled = false;let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await nodeDebugStatus(id);
        if (!cancelled) { setStatus(state);if (!state) setPhase((phase) => phase === 'ready' ? 'closed' : phase);if (state?.phase === 'cleanup_failed') setError(state.error?.message ?? state.detail); }
      } catch (error) { if (!cancelled) setError(fail(error)); }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    void poll();return () => { cancelled = true;clearTimeout(timer); };
  }, [native, id]);
  async function start(nextShell = shell) {
    if (!context || !session.resourceName || !uid || recreated || busy) return;
    autoStarted.current = true;
    setError('');setPhase('preparing');setResource(undefined);setStatus(null);setShell(nextShell);
    let started: { id: string; abort: AbortController } | undefined;
    try {
      if (active.current) { active.current.abort.abort();await stopNodeDebug(active.current.id); }
      if (!mounted.current) return;
      const next = { id: crypto.randomUUID(), abort: new AbortController() };active.current = next;started = next;setId(next.id);
      const resource = await prepareNodeDebug(next.id, { resource: { ...resourceQuery(context, 'Node'), name: session.resourceName, uid }, namespace, image }, next.abort.signal);
      if (!mounted.current || next.abort.signal.aborted) return;
      setResource(resource);setPhase('ready');setShowSetup(false);
    } catch (error) { if (mounted.current && !started?.abort.signal.aborted) { setError(fail(error));setPhase('failed'); } }
  }
  const startRef = useRef(start); startRef.current = start;
  useEffect(() => {
    if (!native || !visible || !uid || recreated || autoStarted.current || phase !== 'idle') return;
    // Defer until committed: StrictMode's discarded mount must not create a helper.
    const timer = setTimeout(() => { if (!autoStarted.current) void startRef.current(); }, 0);
    return () => clearTimeout(timer);
  }, [native, visible, uid, recreated, phase]);
  async function stop() {
    const current = active.current;if (!current) return;
    setPhase('closing');current.abort.abort();
    try { await stopNodeDebug(current.id);if (mounted.current) { setError('');setPhase('closed');setStatus(null); } }
    catch (error) { if (mounted.current) { setError(fail(error));setPhase('cleanup_failed'); } }
  }
  async function loadOthers() {
    if (!context || !isValidNamespaceName(namespace)) return;
    setListing(true);setError('');
    try { const pods = await otherDebugPods(context, namespace);if (mounted.current) setOthers(pods); }
    catch (error) { if (mounted.current) setError(fail(error)); }
    finally { if (mounted.current) setListing(false); }
  }
  const terminalSession: DockSession | undefined = resource ? { ...session, targetType: 'pod', uid: resource.uid ?? undefined, context: resource.context, kind: 'Pod', resourceName: resource.name, namespace: resource.namespace ?? undefined, container: 'debugger', allContainers: ['debugger'] } : undefined;
  return <div className="h-full flex flex-col min-h-0 min-w-0" data-testid="node-shell">
    <div className="shrink-0 px-3 py-2 space-y-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] max-h-[55%] overflow-auto">
      <div className="flex flex-wrap items-center gap-2 text-xs"><strong className="font-mono break-all">Node: {session.resourceName}</strong><span className="text-[var(--text-muted)]">{context} · {status?.phase ?? phase}{status?.detail ? ` · ${status.detail}` : ''}</span>{resource && <Button size="sm" onClick={() => setShowSetup((show) => !show)}>{showSetup ? 'Hide setup' : 'Configure'}</Button>}</div>
      {(showSetup || !resource) && <p className="text-xs text-[var(--text-secondary)]">Connecting through a managed debug Pod on this Linux node. A system dialog reviews its privileged host access before creation. Kubiki deletes the helper when the shell closes; cleanup failures are shown here.</p>}
      {!native && <p className="text-xs text-[var(--status-warn)]">Node shell is available in the desktop app.</p>}
      {(!uid || recreated) && <p className="text-xs text-[var(--status-warn)]">Reopen the current Node before starting a shell.</p>}
      <div className="flex flex-wrap items-end gap-2">
        {(showSetup || !resource) && <><label className="text-xs min-w-0 flex-[1_1_140px]">Debug Pod namespace<Input aria-label="Debug Pod namespace" value={namespace} onChange={(e) => { setNamespace(e.target.value);setOthers([]); }} disabled={busy} invalid={!isValidNamespaceName(namespace)} /></label>
        <label className="text-xs min-w-0 flex-[2_1_220px]">Debug image<Input aria-label="Debug image" value={image} onChange={(e) => setImage(e.target.value)} disabled={busy} /></label>
        <Button size="sm" disabled={!native || !context || !uid || recreated || busy || !isValidNamespaceName(namespace) || !image.trim()} onClick={() => void start()}>{phase === 'failed' || phase === 'closed' ? 'Reconnect node shell' : 'Start node shell'}</Button></>}
        {(id || busy) && <Button size="sm" onClick={() => void stop()}>{busy ? 'Cancel preparation' : 'Stop and delete Pod'}</Button>}
        {status?.phase === 'cleanup_failed' && <Button size="sm" onClick={() => void stop()}>Retry cleanup</Button>}
        <Button size="sm" disabled={!native || !context || listing || busy || !isValidNamespaceName(namespace)} onClick={() => void loadOthers()}>Other debug Pods</Button>
      </div>
      {(resource || status) && <p className="font-mono text-xs text-[var(--text-muted)] break-all">Debug Pod: {resource?.namespace ?? status?.namespace}/{resource?.name ?? status?.name}</p>}
      {error && <p role="alert" className="text-xs text-[var(--status-danger)] break-words">{error}</p>}
      {!!others.length && <section aria-label="Other Kubiki debug Pods" className="space-y-2">
        <p className="text-xs text-[var(--text-muted)]">These Pods have no active session in this Kubiki process. Check that another Kubiki instance is not using a Pod before deleting it.</p>
        {others.map((pod) => <div key={pod.resource.uid} className="flex items-center flex-wrap gap-2 text-xs"><span className="font-mono flex-1 break-all">{pod.resource.name} · {pod.node} · {pod.phase}</span><Button size="sm" aria-label={`Delete debug Pod ${pod.resource.name}`} onClick={() => { void removeOtherDebugPod(pod.resource).then(() => setOthers((items) => items.filter((item) => item.resource.uid !== pod.resource.uid))).catch((error) => setError(fail(error))); }}>Delete</Button></div>)}
      </section>}
    </div>
    <div className="flex-1 min-h-0">{terminalSession && resource ? <LiveTerminalPane key={resource.uid} session={terminalSession} visible={visible} nodeDebug={{ id, node: session.resourceName ?? '', shell, onReconnect: () => void start(), onShellChange: (shell) => void start(shell) }} /> : <div className="p-4 text-xs text-[var(--text-muted)]">{busy ? 'Preparing or cleaning up the debug Pod…' : 'Choose the debug Pod namespace and image, then start a node shell.'}</div>}</div>
  </div>;
}
