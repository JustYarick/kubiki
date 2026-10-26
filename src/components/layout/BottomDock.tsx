import { TerminalSessionPane } from '../k8s/TerminalSessionPane';
export { TerminalSessionPane } from '../k8s/TerminalSessionPane';
import { LogsSessionPane } from '../k8s/LogsSessionPane';
export { LogsSessionPane } from '../k8s/LogsSessionPane';
import { PFDialog } from '../dialogs/PFDialog';
import { stopPortForward, openForwardUrl } from '../../providers/port_forward';
import type { ResourceItem } from '../../types/k8s';
import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  ChevronDown,
  Plus,
  Terminal as TerminalIcon,
  X,
  Maximize2,
  Minimize2,
  ArrowRightLeft,
  Laptop,
  Server,
  FileText,
  ExternalLink,
} from 'lucide-react';
import { inNamespaceScope } from '../../core/resources/namespace_scope';
import { k8s } from '../../providers/k8s_provider';
import { usePfStore } from '../../state/pf_store';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { useDockStore, type DockSession } from '../../state/dock_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useUiStore } from '../../state/ui_store';
import { uiPixels, uiFactor } from '../../core/appearance';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Popover } from '../ui/Dropdown';
import { Modal } from '../ui/Modal';
import { SearchInput } from '../ui/Input';
import { toast } from '../../state/notifications_store';
import { fmtBytes, fmtElapsed } from '../../core/utils/fmt';
import { cx } from '../../core/utils/cx';

const ExpandedDock: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    dockHeight,
    dockCollapsed,
    toggleDock,
    setDockHeight,
    closeSession,
    setActiveSession,
    openLocalTerminal,
    openNodeShell,
    openTerminal,
    openLogs,
    openPorts,
    openEvents,
  } = useDockStore();

  const pfCount = usePfStore((s) => s.sessions.length);
  const resources = useResourceStore((s) => s.resources);
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const [visited, setVisited] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!dockCollapsed && activeSession) setVisited((previous) => {
      if (previous.has(activeSession.id)) return previous;
      return new Set([...previous, activeSession.id]);
    });
  }, [dockCollapsed, activeSession?.id]);

  const [isMaximized, setIsMaximized] = useState(false);
  const [prevHeight, setPrevHeight] = useState(dockHeight);

  const toggleMaximize = () => {
    if (isMaximized) {
      setDockHeight(prevHeight);
      setIsMaximized(false);
    } else {
      setPrevHeight(dockHeight);
      setDockHeight((window.innerHeight - 170) / uiFactor(useUiStore.getState().uiScale));
      setIsMaximized(true);
    }
  };

  const allPods = useMemo(() => Array.from(resources['Pod']?.values() || []), [resources]);
  const allNodes = useMemo(() => Array.from(resources['Node']?.values() || []), [resources]);

  if (sessions.length === 0) {
    return (
      <div
        className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
        style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
      >
        <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-center justify-between px-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] select-none">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <TerminalIcon size="calc(13px * var(--ui-factor))" />
            <span className="font-semibold uppercase tracking-wider text-[length:calc(10px*var(--ui-factor))]">Bottom panel · no open sessions</span>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              icon={Plus}
              size="sm"
              onClick={() => openLocalTerminal()}
              tooltip="Open Local Terminal"
              aria-label="New Session"
            />
            <IconButton
              icon={ChevronDown}
              size="sm"
              onClick={toggleDock}
              tooltip="Collapse Panel (⌘J)"
              aria-label="Collapse"
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-[var(--text-muted)] bg-[var(--bg-canvas)]">
          <Laptop size="calc(32px * var(--ui-factor))" className="text-[var(--text-muted)] mb-2 opacity-60" />
          <p className="mb-3 text-[var(--text-secondary)]">All bottom drawer tabs have been closed.</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => openLocalTerminal()}>
              <Laptop size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Open Local Terminal (Host PC)
            </Button>
            <Button size="sm" onClick={() => openPorts()}>
              <ArrowRightLeft size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Port Forwarding
            </Button>
            <Button size="sm" onClick={() => openEvents()}>
              <Bell size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Cluster Events
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const getSessionIcon = (s: DockSession) => {
    if (s.type === 'terminal') {
      if (s.targetType === 'local') return Laptop;
      if (s.targetType === 'node') return Server;
      return TerminalIcon;
    }
    if (s.type === 'logs') return FileText;
    if (s.type === 'ports') return ArrowRightLeft;
    return Bell;
  };

  const getSessionColor = (s: DockSession) => {
    if (s.type === 'terminal') {
      if (s.targetType === 'local') return 'text-sky-400';
      if (s.targetType === 'node') return 'text-amber-400';
      return 'text-emerald-400';
    }
    if (s.type === 'logs') return 'text-blue-400';
    if (s.type === 'ports') return 'text-amber-400';
    return 'text-purple-400';
  };

  return (
    <div
      className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
      style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
    >
      {/* Lens-Grade Multi-Session Tab Strip */}
      <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-stretch border-b border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto overflow-y-hidden kubiki-scrollbar select-none">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const Icon = getSessionIcon(s);
          const iconColor = getSessionColor(s);

          return (
            <div
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              className={cx(
                'group relative flex items-center gap-1.5 px-3 min-w-[calc(130px*var(--ui-factor))] max-w-[calc(240px*var(--ui-factor))] h-full border-r border-[var(--border-default)] cursor-pointer transition-colors',
                isActive
                  ? 'bg-[var(--bg-canvas)] text-[var(--text-primary)] font-medium'
                  : 'bg-[var(--bg-inactive-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              )}
              title={`${s.title} (${s.subtitle || ''})`}
            >
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-[calc(2px*var(--ui-factor))] bg-[var(--accent)]" />
              )}

              <Icon
                size="calc(12px * var(--ui-factor))"
                className={cx('shrink-0', iconColor)}
              />

              <div className="flex flex-col min-w-0 flex-1 leading-tight text-left">
                <span className="truncate text-[length:calc(11.5px*var(--ui-factor))]">{s.title}</span>
                {s.subtitle && (
                  <span className="truncate text-[length:calc(9.5px*var(--ui-factor))] font-mono text-[var(--text-muted)]">
                    {s.subtitle}
                  </span>
                )}
              </div>

              {s.type === 'ports' && pfCount > 0 && (
                <span className="text-[length:calc(9.5px*var(--ui-factor))] font-mono px-1 rounded-full bg-[var(--status-ok)]/20 text-[var(--status-ok)]">
                  {pfCount}
                </span>
              )}

              {/* Unconditional close button for every session */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                className={cx(
                  'p-0.5 rounded hover:bg-[var(--bg-elevated)] hover:text-white transition-opacity ml-1',
                  isActive ? 'opacity-70 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-70'
                )}
                title="Close Session"
              >
                <X size="calc(11px * var(--ui-factor))" />
              </button>
            </div>
          );
        })}

        <div className="flex-1" />

        {/* Plus Button: Add New Session (Lens Style) */}
        <div className="flex items-center px-1 gap-0.5 shrink-0 bg-[var(--bg-secondary)]">
          <Popover
            width={260}
            trigger={({ open }) => (
              <IconButton
                icon={Plus}
                size="sm"
                active={open}
                tooltip="New Terminal, Logs, or Tool"
                aria-label="New Session"
              />
            )}
          >
            {(close) => (
              <div className="py-1 max-h-[calc(380px*var(--ui-factor))] overflow-y-auto kubiki-scrollbar">
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                  Workstation &amp; Cluster Tools
                </div>
                <button
                  onClick={() => {
                    openLocalTerminal();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <Laptop size="calc(13px * var(--ui-factor))" className="text-sky-400" />
                  <div className="flex flex-col text-left">
                    <span className="font-medium">Local Terminal (Host PC)</span>
                    <span className="text-[length:calc(9.5px*var(--ui-factor))] text-[var(--text-muted)]">{k8s.simulateHostSessions ? 'Simulated local shell' : 'Your workstation · home directory'}</span>
                  </div>
                </button>
                <button
                  onClick={() => {
                    openPorts();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <ArrowRightLeft size="calc(13px * var(--ui-factor))" className="text-amber-400" />
                  <span>Port Forwarding Manager</span>
                </button>
                <button
                  onClick={() => {
                    openEvents();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <Bell size="calc(13px * var(--ui-factor))" className="text-purple-400" />
                  <span>Cluster Event Stream</span>
                </button>

                {/* Node Shells */}
                <div className="my-1 h-px bg-[var(--border-subtle)]" />
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Node Shells (Cluster Nodes)
                </div>
                {allNodes.length === 0 ? (
                  <div className="px-3 py-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">No loaded nodes</div>
                ) : (
                  allNodes.slice(0, 6).map((node) => (
                    <button
                      key={node.uid}
                      onClick={() => {
                        openNodeShell(node.name);
                        close();
                      }}
                      className="w-full flex items-center justify-between px-2.5 py-1 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Server size="calc(12px * var(--ui-factor))" className="text-amber-400 shrink-0" />
                        <span className="font-mono text-[length:calc(11px*var(--ui-factor))] truncate">{node.name}</span>
                      </div>
                      <span className="text-[length:calc(9.5px*var(--ui-factor))] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)]">
                        Shell
                      </span>
                    </button>
                  ))
                )}

                {/* Attach to Pod */}
                <div className="my-1 h-px bg-[var(--border-subtle)]" />
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Attach to Running Pod
                </div>
                {allPods.length === 0 ? (
                  <div className="px-2.5 py-1 text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)]">No pods found</div>
                ) : (
                  allPods.slice(0, 8).map((p) => (
                    <div key={p.uid} className="flex items-center justify-between px-2.5 py-1 hover:bg-[var(--bg-hover)] text-[length:calc(11px*var(--ui-factor))]">
                      <span className="font-mono truncate max-w-[calc(130px*var(--ui-factor))] text-[var(--text-secondary)]">{p.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            openTerminal(p.name, p.namespace, undefined, p.containers?.map((c) => c.name));
                            close();
                          }}
                          className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[length:calc(10px*var(--ui-factor))]"
                        >
                          Shell
                        </button>
                        <button
                          onClick={() => {
                            openLogs(p.name, p.namespace, undefined, p.containers?.map((c) => c.name));
                            close();
                          }}
                          className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[length:calc(10px*var(--ui-factor))]"
                        >
                          Logs
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </Popover>

          {activeSession?.type === 'terminal' && <IconButton icon={ExternalLink} size="sm" aria-label="Open terminal in tab" tooltip="Open a new terminal tab for this target" onClick={() => {
            useWorkspaceStore.getState().openTerminalSession({ ...activeSession, id: `terminal-${crypto.randomUUID()}` });
            useDockStore.getState().setDockCollapsed(true);
          }} />}
          <IconButton
            icon={isMaximized ? Minimize2 : Maximize2}
            size="sm"
            onClick={toggleMaximize}
            tooltip={isMaximized ? 'Restore Height' : 'Maximize Panel'}
            aria-label="Maximize"
          />

          <IconButton
            icon={ChevronDown}
            size="sm"
            onClick={toggleDock}
            tooltip="Collapse Panel (⌘J)"
            aria-label="Collapse"
          />
        </div>
      </div>

      {/* Active Session Content */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-canvas)]">
        {sessions.filter((session) => visited.has(session.id)).map((session) => {
          const visible = !dockCollapsed && session.id === activeSession?.id;
          return <div key={session.id} hidden={!visible} className="h-full min-h-0">
            {session.type === 'terminal' && <TerminalSessionPane session={session} visible={visible} />}
            {session.type === 'logs' && <LogsSessionPane session={session} visible={visible} />}
            {session.type === 'ports' && <PortsPane />}
            {session.type === 'events' && <EventsPane />}
          </div>;
        })}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Terminal Session Component                                         */
/* ------------------------------------------------------------------ */

function PortsPane() {
  const sessions = usePfStore((s) => s.sessions);
  const remove = usePfStore((s) => s.remove);
  const resources = useResourceStore(state => state.resources);
  const scope = useClusterStore((s) => s.selectedNamespace);
  const [addOpen, setAddOpen] = useState(false);
  const [targetSearch, setTargetSearch] = useState('');
  const [target, setTarget] = useState<ResourceItem | null>(null);
  const [stopping, setStopping] = useState<string>();
  const candidates = [...resources.Pod.values(), ...resources.Service.values()].filter(item => inNamespaceScope(scope, item.namespace) && (item.name.toLowerCase().includes(targetSearch.trim().toLowerCase()) || (item.namespace ?? '').toLowerCase().includes(targetSearch.trim().toLowerCase())));

  useEffect(() => {
    if (!k8s.demo) return;
    const iv = setInterval(() => usePfStore.getState().tick(), 800);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      <div className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
        <span className="text-[length:calc(11.5px*var(--ui-factor))] font-semibold text-[var(--text-secondary)]">Port forwarding ({sessions.length})</span>
        <Button size="sm" variant="primary" onClick={() => setAddOpen(true)}>
          <Plus size="calc(12px * var(--ui-factor))" /> Add Tunnel
        </Button>
      </div>

      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        {sessions.length === 0 ? (
          <div className="text-center py-8 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
            No active port forward sessions. Forward ports from Pods/Services or click Add Tunnel above.
          </div>
        ) : (
          <table className="datagrip-grid w-full table-fixed" aria-label="Port forward sessions">
            <thead>
              <tr>
                <th className="datagrip-th">Target / selected Pod</th>
                <th className="datagrip-th">Local URL / traffic</th>
                <th className="datagrip-th" style={{ width: uiPixels(58) }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="datagrip-row">
                  <td className="datagrip-cell font-mono text-[var(--text-primary)] font-medium">
                    {s.targetKind}/{s.targetName}
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal break-all">{s.namespace} · {s.context ?? 'Demo'}</span>
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal break-all">{s.live ? `${s.phase} · ${s.podName}:${s.podPort}` : 'Demo · simulated'} · requested :{s.remotePort}</span>
                    {s.error && <span role="status" className="block text-xs text-[var(--status-warn)] whitespace-normal max-w-80">{s.error}</span>}
                  </td>
                  <td className="datagrip-cell font-mono">
                    <button className="text-[var(--accent)] hover:underline whitespace-normal break-all text-left" onClick={() => { if (!s.live) toast.info('Demo tunnel', 'No real listener is open'); else void openForwardUrl(s.localPort).catch(failure => toast.error('Could not open URL', String(failure))); }}>http://127.0.0.1:{s.localPort}</button>
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal mt-1">TX {fmtBytes(s.bytesOut)} · RX {fmtBytes(s.bytesIn)}</span>
                    <span className="block text-xs text-[var(--text-secondary)]">{fmtElapsed(Math.max(0, Date.now() - s.startedAt))}</span>
                  </td>
                  <td className="datagrip-cell text-right">
                    <button
                      disabled={stopping === s.id} aria-label={`Stop forward ${s.targetName}`}
                      onClick={() => { setStopping(s.id); void (s.live ? stopPortForward(s.id) : Promise.resolve()).then(() => remove(s.id)).catch(failure => toast.error('Could not stop tunnel', String(failure))).finally(() => setStopping(undefined)); }}
                      className="px-1.5 py-0.5 rounded text-[length:calc(10.5px*var(--ui-factor))] text-[var(--status-danger)] hover:bg-[var(--status-danger)]/15"
                    >
                      Stop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Choose a port-forward target" width={500}>
        <p className="text-xs text-[var(--text-secondary)] mb-3">Select a loaded Pod or Service in the current context. Use resource search and namespace scope to load another target.</p>
        <SearchInput value={targetSearch} onChange={setTargetSearch} placeholder="Find Pod or Service…" className="mb-2" /><p className="text-xs text-[var(--text-secondary)] mb-2">Showing {Math.min(100, candidates.length)} of {candidates.length}</p>
        <div className="max-h-80 overflow-auto kubiki-scrollbar">{candidates.slice(0, 100).map(item => <button key={`${item.kind}/${item.uid}`} className="w-full text-left px-2 py-2 hover:bg-[var(--bg-hover)] text-xs" onClick={() => { setTarget(item); setAddOpen(false); }}><span className="text-[var(--text-secondary)]">{item.kind} · {item.namespace}</span><span className="block font-mono break-all">{item.name}</span></button>)}{!candidates.length && <p className="text-xs">No Pod or Service snapshots loaded.</p>}</div>
      </Modal>
      {target && <PFDialog item={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Events Session Pane                                                */
/* ------------------------------------------------------------------ */

interface ClusterEvent {
  id: string;
  type: 'Normal' | 'Warning';
  reason: string;
  object: string;
  message: string;
  count: number;
  age: string;
}

const MOCK_EVENTS: ClusterEvent[] = [
  { id: 'ev-1', type: 'Normal', reason: 'Scheduled', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Successfully assigned frontend/web-frontend to node-1b', count: 1, age: '3m' },
  { id: 'ev-2', type: 'Normal', reason: 'Pulling', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Pulling image "ghcr.io/kubiki/web:v0.34.0"', count: 1, age: '2m' },
  { id: 'ev-3', type: 'Normal', reason: 'Pulled', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Successfully pulled image in 1.42s', count: 1, age: '2m' },
  { id: 'ev-4', type: 'Warning', reason: 'FailedMount', object: 'Pod/backup-worker-0', message: 'MountVolume.SetUp failed for volume "backup-cache": pvc pending', count: 4, age: '4m' },
  { id: 'ev-5', type: 'Normal', reason: 'ScalingReplicaSet', object: 'Deployment/api-gateway', message: 'Scaled up replica set api-gateway-7f98c76b9 to 1', count: 1, age: '14m' },
  { id: 'ev-6', type: 'Warning', reason: 'BackOff', object: 'Pod/payment-worker-6789b-9876x', message: 'Back-off restarting failed container worker in pod', count: 12, age: '18m' },
];

function EventsPane() {
  const events = useResourceStore((s) => s.resources.Event);
  const loadError = useResourceStore((s) => s.loadErrors.Event);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Normal' | 'Warning'>('All');

  const filtered = useMemo(() => {
    let list: ClusterEvent[] = k8s.demo ? MOCK_EVENTS : [...events.values()].map((event) => {
      const raw = event.raw ?? {};
      const ref = raw.involvedObject ?? raw.regarding ?? {};
      return { id: event.uid, type: raw.type === 'Warning' ? 'Warning' : 'Normal', reason: raw.reason ?? '', object: `${ref.kind ?? ''}/${ref.name ?? ''}`, message: raw.message ?? raw.note ?? '', count: raw.count ?? raw.series?.count ?? 1, age: event.age ?? '—' };
    });
    if (typeFilter !== 'All') list = list.filter((e) => e.type === typeFilter);
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((e) => (e.reason + ' ' + e.object + ' ' + e.message).toLowerCase().includes(q));
    }
    return list;
  }, [typeFilter, filter, events]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <span className="font-semibold text-[var(--text-secondary)]">Cluster Event Log</span>
        <div className="flex items-center gap-1 bg-[var(--bg-canvas)] p-0.5 rounded border border-[var(--border-default)]">
          {(['All', 'Warning', 'Normal'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cx(
                'px-2 py-0.5 rounded text-[length:calc(10.5px*var(--ui-factor))]',
                typeFilter === t ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter events…" className="w-[calc(180px*var(--ui-factor))] h-[calc(22px*var(--ui-factor))]" />
      </div>

      {loadError && <div role="alert" className="p-2 text-[var(--status-warn)] text-xs">{loadError.message}</div>}
      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        <table className="datagrip-grid w-full">
          <thead>
            <tr>
              <th className="datagrip-th w-[calc(90px*var(--ui-factor))]">Type</th>
              <th className="datagrip-th w-[calc(130px*var(--ui-factor))]">Reason</th>
              <th className="datagrip-th w-[calc(240px*var(--ui-factor))]">Resource</th>
              <th className="datagrip-th">Message</th>
              <th className="datagrip-th w-[calc(60px*var(--ui-factor))] text-right">Count</th>
              <th className="datagrip-th w-[calc(80px*var(--ui-factor))] text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="datagrip-row">
                <td className="datagrip-cell">
                  <span
                    className={cx(
                      'text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase px-1.5 py-0.5 rounded',
                      e.type === 'Warning' ? 'bg-[var(--status-warn)]/15 text-[var(--status-warn)]' : 'bg-[var(--status-ok)]/15 text-[var(--status-ok)]'
                    )}
                  >
                    {e.type}
                  </span>
                </td>
                <td className="datagrip-cell font-mono text-[var(--text-primary)] font-medium">{e.reason}</td>
                <td className="datagrip-cell font-mono text-[var(--text-secondary)]">{e.object}</td>
                <td className="datagrip-cell text-[var(--text-primary)]">{e.message}</td>
                <td className="datagrip-cell text-right font-mono text-[var(--text-muted)]">{e.count}</td>
                <td className="datagrip-cell text-right font-mono text-[var(--text-muted)]">{e.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BottomDock() {
  const { dockCollapsed, toggleDock, sessions } = useDockStore();
  return <div className="shrink-0 min-h-0">
    {dockCollapsed && <button onClick={toggleDock} className="w-full h-7 flex items-center gap-2 px-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" aria-label="Expand bottom panel"><TerminalIcon size="calc(12px * var(--ui-factor))" /><span>Bottom panel</span><span className="text-[var(--text-muted)]">{sessions.length} open tabs</span><span className="ml-auto text-[length:calc(10px*var(--ui-factor))]">{shortcutLabel('⌘J')}</span></button>}
    <div hidden={dockCollapsed}><ExpandedDock /></div>
  </div>;
}
