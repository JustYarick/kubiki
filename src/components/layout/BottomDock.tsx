import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChevronDown,
  Download,
  Eraser,
  Pause,
  Play,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  WrapText,
  X,
  ArrowDownToLine,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { usePfStore } from '../../state/pf_store';
import { useResourceStore } from '../../state/resource_store';
import { useUiStore, type DockTab } from '../../state/ui_store';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Popover, MenuList } from '../ui/Dropdown';
import { Modal } from '../ui/Modal';
import { Input, SearchInput, Label } from '../ui/Input';
import { toast } from '../../state/notifications_store';
import { fmtBytes, fmtElapsed } from '../../core/utils/fmt';
import { cx } from '../../core/utils/cx';

/* ------------------------------------------------------------------ */
/* Dock shell                                                          */
/* ------------------------------------------------------------------ */

const TABS: Array<{ id: DockTab; label: string; icon: LucideIcon }> = [
  { id: 'logs', label: 'Logs', icon: ArrowDownToLine },
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'ports', label: 'Ports', icon: Plus },
  { id: 'events', label: 'Events', icon: Bell },
];

export const BottomDock: React.FC = () => {
  const { dockCollapsed, dockHeight, toggleDock, activeDockTab } = useUiStore();
  const pfCount = usePfStore((s) => s.sessions.length);

  /* Lazy tab mounting: a pane is created the FIRST time it becomes active,
     then kept alive (xterm scrollback etc). Nothing streams until opened. */
  const [visited, setVisited] = useState<Set<DockTab>>(() => new Set([activeDockTab]));
  useEffect(() => {
    setVisited((prev) => (prev.has(activeDockTab) ? prev : new Set(prev).add(activeDockTab)));
  }, [activeDockTab]);

  if (dockCollapsed) {
    return (
      <div className="shrink-0 h-[30px] border-t border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center px-3 gap-2 select-none">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Bottom panel</span>
        <span className="text-[11px] text-[var(--text-secondary)]">{TABS.find((t) => t.id === activeDockTab)?.label}</span>
        <div className="flex-1" />
        <IconButton icon={ChevronDown} size="sm" onClick={toggleDock} tooltip="Expand panel" className="rotate-180" aria-label="Expand" />
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col" style={{ height: dockHeight }}>
      {/* Tab strip */}
      <div className="h-8 shrink-0 flex items-center px-2 gap-0.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60">
        {TABS.map((t) => {
          const active = activeDockTab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => useUiStore.getState().openDock(t.id)}
              className={cx(
                'flex items-center gap-1.5 h-[24px] px-2.5 rounded-[4px] text-[11px] font-medium transition-colors',
                active ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/60'
              )}
            >
              <Icon size={12} />
              {t.label}
              {t.id === 'ports' && pfCount > 0 && (
                <span className="text-[9.5px] font-mono px-1 rounded-full bg-[var(--status-ok)]/15 text-[var(--status-ok)]">{pfCount}</span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        <IconButton icon={ChevronDown} size="sm" onClick={toggleDock} tooltip="Collapse (⌘J)" aria-label="Collapse" />
      </div>

      {/* Panes (kept mounted after first visit to preserve state across tab switches) */}
      <div className="flex-1 min-h-0 relative">
        <Pane hidden={activeDockTab !== 'logs'}>{visited.has('logs') ? <LogsPane visible={activeDockTab === 'logs'} /> : null}</Pane>
        <Pane hidden={activeDockTab !== 'terminal'}>{visited.has('terminal') ? <TerminalPane /> : null}</Pane>
        <Pane hidden={activeDockTab !== 'ports'}>{visited.has('ports') ? <PortsPane /> : null}</Pane>
        <Pane hidden={activeDockTab !== 'events'}>{visited.has('events') ? <EventsPane visible={activeDockTab === 'events'} /> : null}</Pane>
      </div>
    </div>
  );
};

function Pane({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  return <div className={cx('absolute inset-0 flex flex-col', hidden && 'invisible pointer-events-none')} aria-hidden={hidden}>{children}</div>;
}

function DockToolbar({ children }: { children: React.ReactNode }) {
  return <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/30">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Terminal (mock shell via xterm)                                     */
/* ------------------------------------------------------------------ */

const PODS_LINE = (pods: { name: string; namespace?: string; status?: string; ready?: string }[]) => {
  const w = 52;
  let out = `NAME${' '.repeat(4)} READY  STATUS       RESTARTS  AGE\n`;
  for (const p of pods.slice(0, 12)) {
    const ready = (p.ready ?? '0/1').padEnd(6);
    const status = (p.status ?? 'Running').padEnd(12);
    out += `${p.name.padEnd(w)} ${ready} ${status} 0         3h\n`;
  }
  return out;
};

function terminalExec(input: string, write: (s: string) => void, pods: { name: string; namespace?: string; status?: string; ready?: string }[]) {
  const cmd = input.trim();
  if (!cmd) return;
  const parts = cmd.split(/\s+/);
  if (cmd === 'clear') {
    write('\x1b[2J\x1b[H');
    return;
  }
  if (cmd === 'help') {
    write('\r\nCommands: kubectl get <pods|deployments|services|configmaps|secrets> [-n ns], kubectl version, kubectl config get-contexts, clear, exit\r\n');
    return;
  }
  if (parts[0] === 'kubectl') {
    if (parts[1] === 'version') {
      write('\r\nClient Version: v1.31.2\r\nServer Version: v1.31.2 (mock)\r\n');
      return;
    }
    if (parts[1] === 'config' && parts[2] === 'get-contexts') {
      write('\r\nCURRENT  NAME        CLUSTER     NAMESPACE\r\n*        local-dev   minikube    default\r\n         prod-eu     prod        backend\r\n');
      return;
    }
    if (parts[1] === 'get') {
      const kindWanted = (parts[2] ?? '').replace(/s$/, '');
      const map: Record<string, string> = { pod: 'Pod', po: 'Pod', deploy: 'Deployment', deployment: 'Deployment', svc: 'Service', service: 'Service', cm: 'ConfigMap', configmap: 'ConfigMap', secret: 'Secret' };
      const resolved = map[kindWanted];
      if (!resolved) {
        write(`\r\nerror: unknown resource "${parts[2] ?? ''}" (try pods|deployments|services|configmaps|secrets)\r\n`);
        return;
      }
      const nsIdx = parts.indexOf('-n');
      const ns = nsIdx >= 0 ? parts[nsIdx + 1] : undefined;
      if (resolved === 'Pod') {
        write('\r\n' + PODS_LINE(ns ? pods.filter((p) => p.namespace === ns) : pods));
        return;
      }
      write(`\r\nNo resources found in ${ns ?? 'all namespaces'} (mock, try 'kubectl get pods')\r\n`);
      return;
    }
    write(`\r\nerror: unknown command "${parts[1]}"\r\n`);
    return;
  }
  if (cmd === 'exit') {
    write('\r\nbye — session stays open in demo mode\r\n');
    return;
  }
  write(`\r\nsh: command not found: ${parts[0]} — try 'help'\r\n`);
}

function TerminalPane() {
  /* subscribe to pod count so the list refreshes once the cluster seeds */
  const podCount = useResourceStore((s) => s.resources.Pod.size);
  const pods = useMemo(() => Array.from(useResourceStore.getState().resources.Pod.values()).slice(0, 20), [podCount]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef('');

  const [target, setTarget] = useState<string>('host');
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new XTerm({
      fontSize: 12,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
      theme: {
        background: '#1e1f22',
        foreground: '#dfe1e5',
        cursor: '#3574f0',
        selectionBackground: '#3574f044',
        black: '#1e1f22', brightBlack: '#6f737a',
        green: '#59a869', red: '#e05555', yellow: '#e5b742', blue: '#3574f0', cyan: '#22d3ee', magenta: '#c792ea',
      },
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  /* banner + prompt every time target changes */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const intro =
      target === 'host'
        ? '\r\n\x1b[1mKubiki demo shell\x1b[0m — kubectl commands run against mock data. Type `help`.\r\n\r\n'
        : `\r\n\x1b[1mExecuting into pod\x1b[0m \x1b[36m${target}\x1b[0m (mock session) — type \`help\`.\r\n\r\n`;
    term.write(intro);
    prompt(term);
  }, [target]);

  const prompt = (term: XTerm) => {
    term.write(`\r\n\x1b[32m${target === 'host' ? 'yarick@kubiki' : target.slice(0, 12)}\x1b[0m:\x1b[34m~\x1b[0m$ `);
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const onData = term.onData((data) => {
      if (data === '\r') {
        terminalExec(lineRef.current, (s) => term.write(s), pods);
        lineRef.current = '';
        prompt(term);
        return;
      }
      if (data === '\u007f') {
        if (lineRef.current.length > 0) {
          lineRef.current = lineRef.current.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }
      if (data === '\u0003') {
        lineRef.current = '';
        term.write('^C');
        prompt(term);
        return;
      }
      if (data >= ' ') {
        lineRef.current += data;
        term.write(data);
      }
    });
    return () => onData.dispose();
  }, [target, pods]);

  const resetSession = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write('\x1b[2J\x1b[H');
    term.write('\r\nSession restarted.\r\n');
    prompt(term);
    toast.info('Shell session restarted');
  };

  return (
    <>
      <DockToolbar>
        <Popover
          width={280}
          trigger={({ toggle, open }) => (
            <button
              onClick={toggle}
              className={cx(
                'flex items-center gap-1.5 h-[24px] px-2 rounded-[4px] border text-[11px] font-mono transition-colors max-w-[260px]',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
            >
              <TerminalIcon size={11} className="text-[var(--status-ok)] shrink-0" />
              <span className="truncate">{target === 'host' ? 'host shell (demo)' : target}</span>
              <ChevronDown size={10} className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              items={[
                { id: 'host', label: 'host shell (mock kubectl)', checked: target === 'host', onSelect: () => setTarget('host') },
                ...pods.slice(0, 10).map((p) => ({
                  id: p.name,
                  label: p.name,
                  checked: target === p.name,
                  onSelect: () => setTarget(p.name),
                })),
              ]}
              onSelect={(item) => { item.onSelect?.(); close(); }}
            />
          )}
        </Popover>
        <div className="flex-1" />
        <IconButton icon={RotateCw} size="sm" onClick={resetSession} tooltip="Restart session" aria-label="Restart shell" />
        <IconButton
          icon={Eraser}
          size="sm"
          tooltip="Clear buffer"
          onClick={() => {
            termRef.current?.clear();
            termRef.current?.write('\x1b[2J\x1b[H');
          }}
          aria-label="Clear"
        />
      </DockToolbar>
      <div ref={containerRef} className="flex-1 min-h-0 pl-2 pt-1" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Logs (mock streaming)                                               */
/* ------------------------------------------------------------------ */

const LOG_TEMPLATES = [
  ['info', 'GET /api/v1/items 200 in {ms}ms'],
  ['info', 'metrics flushed: cpu={ms}'],
  ['info', 'connection accepted from 10.42.{n}.{n}'],
  ['warn', 'retry attempt {n} for downstream payment-api'],
  ['warn', 'slow query detected: 8{n}ms'],
  ['error', 'dial tcp 10.43.0.25:5432: connect: connection refused'],
  ['info', 'health check OK (db, redis)'],
  ['warn', 'grpc keepalive probe missed ({n})'],
];

interface LogLine { t: string; level: string; msg: string; seq: number }

function LogsPane({ visible }: { visible: boolean }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState('');
  const holdRef = useRef(true); // streams only when the tab is actually visible
  holdRef.current = paused || !visible;
  const seqRef = useRef(1);

  useEffect(() => {
    const gen = () => {
      if (holdRef.current) return;
      const [level, tpl] = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
      const msg = tpl.replace('{ms}', String(20 + Math.floor(Math.random() * 400))).replace(/\{n\}/g, () => String(1 + Math.floor(Math.random() * 240)));
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
      setLines((prev) => [...prev, { t, level, msg, seq: seqRef.current++ }].slice(-400));
    };
    const iv = setInterval(gen, 650);
    return () => clearInterval(iv);
  }, []);

  const shown = useMemo(() => (filter ? lines.filter((l) => (l.level + ' ' + l.msg).toLowerCase().includes(filter.toLowerCase())) : lines), [lines, filter]);

  const levelColor = (l: LogLine) =>
    l.level === 'error'
      ? 'text-[#e05555]'
      : l.level === 'warn'
        ? 'text-[#e5b742]'
        : 'text-[var(--text-secondary)]';

  return (
    <>
      <DockToolbar>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter lines…" className="w-[180px]" />
        <div className="flex-1" />
        <IconButton icon={paused ? Play : Pause} size="sm" active={paused} onClick={() => setPaused(!paused)} tooltip={paused ? 'Resume' : 'Pause stream'} aria-label="Pause" />
        <IconButton icon={WrapText} size="sm" active={wrap} onClick={() => setWrap(!wrap)} tooltip="Toggle wrap" aria-label="Wrap" />
        <IconButton
          icon={Download}
          size="sm"
          tooltip="Download log tail"
          onClick={() => {
            const blob = new Blob([lines.map((l) => `${l.t} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'kubiki-logs.txt';
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Log tail downloaded');
          }}
          aria-label="Download logs"
        />
        <IconButton icon={Eraser} size="sm" tooltip="Clear" onClick={() => setLines([])} aria-label="Clear" />
      </DockToolbar>
      <div className="flex-1 min-h-0 overflow-auto kubiki-scrollbar bg-[var(--bg-canvas)] px-3 py-2">
        {shown.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)] font-mono py-3">
            No log stream yet — hover a Pod row in the table and press the Logs action, or select one and use the context menu.
          </div>
        ) : (
          <div className="font-mono text-[11px] leading-[1.45]">
            {shown.map((l) => (
              <div key={l.seq} className={cx(wrap ? 'whitespace-pre-wrap' : 'whitespace-nowrap', levelColor(l))}>
                <span className="text-[var(--text-muted)] select-none pr-2">{l.t}</span>
                <span className={cx('select-none pr-2 font-semibold', l.level === 'error' ? 'text-[var(--status-danger)]' : l.level === 'warn' ? 'text-[var(--status-warn)]' : 'text-[var(--status-ok)]')}>
                  {l.level.toUpperCase().padEnd(5)}
                </span>
                <span>{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Ports (mock port-forward sessions)                                  */
/* ------------------------------------------------------------------ */

function PortsPane() {
  const sessions = usePfStore((s) => s.sessions);
  const remove = usePfStore((s) => s.remove);
  const add = usePfStore((s) => s.add);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => usePfStore.getState().tick(), 800);
    return () => clearInterval(iv);
  }, []);

  return (
    <>
      <DockToolbar>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] px-1">
          Forwarded ports {sessions.length > 0 && <span className="font-mono">({sessions.length})</span>}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 h-[24px] px-2 rounded-[4px] border border-[var(--accent)]/60 text-[11px] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
        >
          <Plus size={12} />
          New forward
        </button>
      </DockToolbar>
      <div className="flex-1 min-h-0 overflow-auto kubiki-scrollbar">
        {sessions.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center px-6">
              <Plus size={28} strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-2" />
              <div className="text-xs text-[var(--text-secondary)]">No active forwards</div>
              <p className="text-[11px] text-[var(--text-muted)] mt-1">Start one from a table row or with the button above.</p>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
              <tr className="kub-th">
                <th className="text-left px-3 h-[24px]">Target</th>
                <th className="text-left px-3">Address</th>
                <th className="text-left px-3">Traffic (in / out)</th>
                <th className="text-left px-3">Uptime</th>
                <th className="text-left px-3">Status</th>
                <th className="w-[60px] p-0" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]/50 h-[26px]">
                  <td className="px-3 font-mono text-[11px] text-[var(--text-primary)] truncate max-w-[220px]">
                    {s.targetKind}/{s.targetName}
                  </td>
                  <td className="px-3 font-mono text-[11px] text-[var(--text-secondary)]">
                    localhost:<span className="text-[var(--text-primary)]">{s.localPort}</span> → {s.remotePort}
                  </td>
                  <td className="px-3 font-mono text-[11px] text-[var(--text-secondary)] tabular-nums">
                    <span className="text-[var(--status-ok)]">↓{fmtBytes(s.bytesIn)}</span> / <span>↑{fmtBytes(s.bytesOut)}</span>
                  </td>
                  <td className="px-3 font-mono text-[11px] text-[var(--text-muted)]">{fmtElapsed(Date.now() - s.startedAt)}</td>
                  <td className="px-3"><LiveBadge /></td>
                  <td className="relative p-0">
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <IconButton icon={X} size="sm" danger onClick={() => { remove(s.id); toast.info('Forward stopped', `${s.targetName}:${s.localPort}`); }} aria-label="Stop forward" tooltip="Stop" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        width={420}
        title="New port-forward"
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                const s = add({ targetKind: 'Service', targetName: 'api-gateway', namespace: 'default', remotePort: 80, localPort: 0, openBrowser: true });
                setAddOpen(false);
                toast.success('Forward started', `localhost:${s.localPort} → api-gateway`);
              }}
            >
              Start
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Target service (demo)</Label>
            <Input value="default/api-gateway" readOnly />
          </div>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            In this milestone the panel ships with a canned demo session. Full targeting UX lands with phase UI-4 (right-click any Pod or Service → Port-forward).
          </p>
        </div>
      </Modal>
    </>
  );
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono text-[var(--status-ok)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-ok)] animate-pulse" />
      forwarding
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Events (mock live stream)                                           */
/* ------------------------------------------------------------------ */

interface KubeEvent {
  id: number;
  severity: 'Normal' | 'Warning';
  reason: string;
  obj: string;
  count: number;
  ts: string;
  msg: string;
}

const EVENT_REASONS: Array<{ severity: KubeEvent['severity']; reason: string; msg: string }> = [
  { severity: 'Normal', reason: 'Scheduled', msg: 'Successfully assigned to node-{n}' },
  { severity: 'Normal', reason: 'Pulling', msg: 'Pulling image "ghcr.io/kubiki/app:v{n}.0.1"' },
  { severity: 'Normal', reason: 'Pulled', msg: 'Successfully pulled image in {ms}ms' },
  { severity: 'Normal', reason: 'Created', msg: 'Created container app' },
  { severity: 'Normal', reason: 'Started', msg: 'Started container app' },
  { severity: 'Normal', reason: 'ScalingReplicaSet', msg: 'Scaled up replica set to {n}' },
  { severity: 'Warning', reason: 'BackOff', msg: 'Back-off restarting failed container' },
  { severity: 'Warning', reason: 'Unhealthy', msg: 'Readiness probe failed: HTTP 503' },
  { severity: 'Warning', reason: 'FailedScheduling', msg: 'Insufficient cpu on gpu-node-1' },
  { severity: 'Warning', reason: 'Evicted', msg: 'The node was low on resource: memory' },
];

function EventsPane({ visible }: { visible: boolean }) {
  const [events, setEvents] = useState<KubeEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [warnOnly, setWarnOnly] = useState(false);
  const [q, setQ] = useState('');
  const holdRef = useRef(true);
  holdRef.current = paused || !visible;
  const seq = useRef(1);

  const kindsSeeded = useResourceStore((s) => s.resources.Pod.size + s.resources.Service.size + s.resources.Deployment.size);
  const objects = useMemo(() => {
    const store = useResourceStore.getState().resources;
    return [
      ...Array.from(store.Pod.values()).map((p) => `pod/${p.name}`),
      ...Array.from(store.Service.values()).map((s) => `service/${s.name}`),
      ...Array.from(store.Deployment.values()).map((d) => `deployment/${d.name}`),
    ];
  }, [kindsSeeded]);

  useEffect(() => {
    const gen = () => {
      if (holdRef.current) return;
      const tpl = EVENT_REASONS[Math.floor(Math.random() * EVENT_REASONS.length)];
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      setEvents((prev) =>
        [
          {
            id: seq.current++,
            severity: tpl.severity,
            reason: tpl.reason,
            obj: objects[Math.floor(Math.random() * objects.length)],
            count: 1,
            ts,
            msg: tpl.msg.replace('{ms}', String(200 + Math.floor(Math.random() * 3000))).replace(/\{n\}/g, () => String(1 + Math.floor(Math.random() * 24))),
          },
          ...prev,
        ].slice(0, 250)
      );
    };
    const iv = setInterval(gen, 2400);
    return () => clearInterval(iv);
  }, [objects]);
  const shown = events.filter(
    (e) => (!warnOnly || e.severity === 'Warning') && (!q || (e.reason + e.obj + e.msg).toLowerCase().includes(q.toLowerCase()))
  );
  const warnCount = events.filter((e) => e.severity === 'Warning').length;

  return (
    <>
      <DockToolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Filter events…" className="w-[180px]" />
        <button
          onClick={() => setWarnOnly(!warnOnly)}
          className={cx(
            'flex items-center gap-1.5 h-[24px] px-2 rounded-[4px] border text-[11px] transition-colors',
            warnOnly
              ? 'border-[var(--status-warn)]/60 bg-[var(--status-warn)]/10 text-[var(--status-warn)]'
              : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
          )}
        >
          {warnCount} warnings
        </button>
        <div className="flex-1" />
        <IconButton icon={paused ? Play : Pause} size="sm" active={paused} onClick={() => setPaused(!paused)} tooltip={paused ? 'Resume' : 'Pause'} aria-label="Pause events" />
        <IconButton icon={Eraser} size="sm" tooltip="Clear" onClick={() => setEvents([])} aria-label="Clear" />
      </DockToolbar>
      <div className="flex-1 min-h-0 overflow-auto kubiki-scrollbar">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] z-10">
            <tr className="kub-th">
              <th className="text-left px-3 h-[24px]">Type</th>
              <th className="text-left px-3">Reason</th>
              <th className="text-left px-3">Message</th>
              <th className="text-left px-3">Object</th>
              <th className="text-left px-3">Count</th>
              <th className="text-left px-3">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]/50">
<td className="px-3 py-[3px]">
                  <span className={cx('inline-flex items-center gap-1.5 font-mono', e.severity === 'Warning' ? 'text-[var(--status-warn)]' : 'text-[var(--text-muted)]')}>
                    <span className={cx('w-1.5 h-1.5 rounded-full', e.severity === 'Warning' ? 'bg-[var(--status-warn)]' : 'bg-[var(--status-neutral)]')} />
                    {e.severity}
                  </span>
                </td>
                <td className="px-3 font-medium text-[var(--text-primary)] whitespace-nowrap">{e.reason}</td>
                <td className="px-3 text-[var(--text-secondary)] max-w-[380px] truncate" title={e.msg}>{e.msg}</td>
                <td className="px-3 font-mono text-[10.5px] text-[var(--text-secondary)] max-w-[220px] truncate">{e.obj}</td>
                <td className="px-3 font-mono text-[var(--text-secondary)] tabular-nums">{e.count}</td>
                <td className="px-3 font-mono text-[var(--text-muted)]">{e.ts}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-[var(--text-muted)]">No events {warnOnly ? '(warnings only)' : 'yet'}{paused ? ' — stream paused' : ''}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
