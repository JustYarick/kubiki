import { toast } from '../../state/notifications_store';
import { Popover } from '../ui/Dropdown';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, Eraser, Laptop, Server, Box, ChevronDown, Check } from 'lucide-react';
import { SessionContainerChoice } from './LogsSessionPane';
import { NodeShellPane } from './NodeShellPane';
import { LiveTerminalPane } from './LiveTerminalPane';
import { ContainerSelect } from './ContainerSelect';
import { useSessionContainers } from './useSessionContainers';
import { useTerminalAppearance } from './useTerminalAppearance';
import { terminalFontStack } from '../../core/terminal_appearance';
import { useResourceStore } from '../../state/resource_store';
import { useUiStore } from '../../state/ui_store';
import { useDockStore, type DockSession } from '../../state/dock_store';
import { k8s } from '../../providers/k8s_provider';
import { IconButton } from '../ui/Button';
import { cx } from '../../core/utils/cx';
import { selectedFirst } from '../../core/utils/selected_first';

export function TerminalSessionPane({ session, visible = true, onContainerChange }: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const choice = useSessionContainers(session, true);
  if (choice.needsSelection) return <SessionContainerChoice session={session} shell onContainerChange={onContainerChange} />;
  if (session.targetType === 'local' && !k8s.simulateHostSessions) return <LiveTerminalPane session={session} visible={visible} />;
  if (!k8s.demo && session.targetType === 'node') return <NodeShellPane session={session} visible={visible} />;
  if (!k8s.demo && (session.targetType === 'pod' || session.targetType === 'local')) return <LiveTerminalPane session={session} visible={visible} onContainerChange={onContainerChange} />;
  if (!k8s.demo) return <div className="p-5 text-xs text-[var(--text-secondary)]">{session.targetType === 'node' ? 'Node debug shell requires a managed debug Pod; this transport is not connected yet.' : 'Local host PTY is not connected yet. Open Shell from a Pod to use Kubernetes exec.'}</div>;
  return <DemoTerminalSessionPane session={session} visible={visible} onContainerChange={onContainerChange} />;
}

function DemoTerminalSessionPane({ session, visible, onContainerChange }: { session: DockSession; visible: boolean; onContainerChange?: (name: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef('');

  const podMap = useResourceStore((s) => s.resources['Pod']);
  const pods = useMemo(() => Array.from(podMap?.values() || []), [podMap]);
  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);

  const isLocal = session.targetType === 'local' || session.resourceName === 'localhost' || session.resourceName === 'local' || !session.resourceName;
  const isNode = session.targetType === 'node' || session.resourceName?.startsWith('node/');
  const isPod = !isLocal && !isNode;

  const activeContainer = session.container || (isLocal ? 'host' : isNode ? 'sh' : 'app');
  const [shellBinary, setShellBinary] = useState(isLocal ? '/bin/zsh' : '/bin/sh');

  const { containers } = useSessionContainers(session, true);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: terminalFontStack(useUiStore.getState().terminalFontFamily),
      fontSize: useUiStore.getState().terminalFontSize,
      lineHeight: useUiStore.getState().terminalLineHeight,
      theme: {
        background: '#1e1f22',
        foreground: '#dfe1e5',
        cursor: '#3574f0',
        selectionBackground: 'rgba(53, 116, 240, 0.35)',
        black: '#1e1f22',
        red: '#e05555',
        green: '#59a869',
        yellow: '#e5b742',
        blue: '#3574f0',
        magenta: '#b392f0',
        cyan: '#39c5bb',
        white: '#dfe1e5',
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* Wait for visible dimensions. */ }
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const ro = new ResizeObserver(() => { if (containerRef.current?.offsetHeight) fit.fit(); });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useTerminalAppearance(termRef, () => { if (containerRef.current?.offsetHeight) fitRef.current?.fit(); }, visible);

  useEffect(() => { if (visible && containerRef.current?.offsetHeight) { fitRef.current?.fit(); termRef.current?.focus(); } }, [visible]);

  const writePrompt = (term: XTerm) => {
    if (isLocal) {
      term.write(`\r\n\x1b[1;32mdemo@localhost\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
    } else if (isNode) {
      term.write(`\r\n\x1b[1;33mroot@${session.resourceName || 'node'}\x1b[0m:\x1b[1;34m/\x1b[0m# `);
    } else {
      const hostStr = `${session.resourceName?.slice(0, 16)}:${activeContainer}`;
      term.write(`\r\n\x1b[32m${hostStr}\x1b[0m:\x1b[34m~\x1b[0m$ `);
    }
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let intro = '';
    if (isLocal) {
      intro = `\r\n\x1b[1;36mKubiki Local Terminal (Host PC)\x1b[0m — simulated shell session using \x1b[33m${shellBinary}\x1b[0m.\r\nWorkstation: \x1b[1;32mdemo@localhost\x1b[0m (demo workstation)\r\nType \`help\`, \`kubectl get pods\`, \`whoami\`, \`pwd\`, or any command.\r\n`;
    } else if (isNode) {
      intro = `\r\n\x1b[1;33mKubiki Node Shell\x1b[0m — simulated shell for node \x1b[1m${session.resourceName}\x1b[0m.\r\nDemo only. No debug container is created.\r\nType \`help\` or any node inspection command.\r\n`;
    } else {
      intro = `\r\n\x1b[1;32mDemo Pod shell for\x1b[0m \x1b[1m${session.resourceName}\x1b[0m (\x1b[36mcontainer: ${activeContainer}\x1b[0m, \x1b[35mns: ${session.namespace}\x1b[0m) using \x1b[33m${shellBinary}\x1b[0m.\r\nType \`help\` or any container command.\r\n`;
    }

    term.write(intro);
    writePrompt(term);
  }, [session.resourceName, activeContainer, shellBinary, isLocal, isNode]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onData = term.onData((data) => {
      if (data === '\r') {
        terminalExec(lineRef.current, (s) => term.write(s), pods, isLocal, isNode, session.resourceName);
        lineRef.current = '';
        writePrompt(term);
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
        writePrompt(term);
        return;
      }
      if (data >= ' ') {
        lineRef.current += data;
        term.write(data);
      }
    });

    return () => onData.dispose();
  }, [session.resourceName, activeContainer, pods, isLocal, isNode]);

  const resetSession = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write('\x1b[2J\x1b[H');
    term.write('\r\nTerminal session restarted.\r\n');
    writePrompt(term);
    toast.info('Terminal session restarted');
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      {/* Target Info Header (Lens-grade) */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2.5 py-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={cx(
              'w-2 h-2 rounded-full shrink-0 animate-pulse',
              isLocal ? 'bg-sky-400' : isNode ? 'bg-amber-400' : 'bg-[var(--status-ok)]'
            )}
          />
          <span className="text-[var(--text-muted)]">Target:</span>
          {isLocal && (
            <div className="flex items-center gap-1 font-mono font-medium text-sky-400">
              <Laptop size="calc(12px * var(--ui-factor))" />
              <span>Local PC (localhost)</span>
            </div>
          )}
          {isNode && (
            <div className="flex items-center gap-1 font-mono font-medium text-amber-400">
              <Server size="calc(12px * var(--ui-factor))" />
              <span>Node Shell: {session.resourceName}</span>
            </div>
          )}
          {isPod && (
            <div className="flex items-center gap-1 font-mono font-medium text-[var(--text-primary)]">
              <Box size="calc(12px * var(--ui-factor))" className="text-emerald-400" />
              <span>{session.resourceName}</span>
            </div>
          )}
          {session.namespace && isPod && (
            <span className="text-[length:calc(10px*var(--ui-factor))] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              ns: {session.namespace}
            </span>
          )}
        </div>

        <div className="h-3.5 w-px bg-[var(--border-default)] mx-1" />

        {isPod && <ContainerSelect shell containers={containers} value={activeContainer} onChange={onContainerChange ?? ((name) => updateSessionContainer(session.id, name))} />}

        {/* Shell Binary Selector Dropdown */}
        <Popover
          width={150}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[calc(22px*var(--ui-factor))] px-1.5 rounded-[calc(3px*var(--ui-factor))] border text-[length:calc(10.5px*var(--ui-factor))] font-mono transition-colors',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'
              )}
              title="Shell Binary"
            >
              <span>{shellBinary}</span>
              <ChevronDown size="calc(10px * var(--ui-factor))" className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1" role="listbox" aria-label="Shell binaries">
              {selectedFirst(isLocal ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/sh', '/bin/bash'], sh => sh === shellBinary).map((sh) => (
                <button
                  key={sh}
                  role="option"
                  aria-selected={sh === shellBinary}
                  onClick={() => {
                    setShellBinary(sh);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-mono">{sh}</span>
                  {shellBinary === sh && <Check size="calc(11px * var(--ui-factor))" className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        <div className="flex-1" />

        <IconButton
          icon={RotateCw}
          size="sm"
          onClick={resetSession}
          tooltip="Restart Shell Session"
          aria-label="Restart"
        />
        <IconButton
          icon={Eraser}
          size="sm"
          tooltip="Clear Terminal Screen"
          onClick={() => {
            termRef.current?.clear();
            termRef.current?.write('\x1b[2J\x1b[H');
          }}
          aria-label="Clear"
        />
      </div>

      {/* Xterm Shell Output */}
      <div ref={containerRef} className="flex-1 min-h-0 pl-2 pt-1" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Logs Session Component                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Terminal kubectl execution logic                                    */
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

function terminalExec(
  input: string,
  write: (s: string) => void,
  pods: { name: string; namespace?: string; status?: string; ready?: string }[],
  isLocal = false,
  isNode = false,
  resourceName?: string
) {
  const cmd = input.trim();
  if (!cmd) return;
  const parts = cmd.split(/\s+/);

  if (cmd === 'clear') {
    write('\x1b[2J\x1b[H');
    return;
  }

  if (cmd === 'help') {
    if (isLocal) {
      write('\r\nLocal Commands: kubectl <get|describe|logs|exec|config>, whoami, pwd, ls, uname, hostname, date, clear, exit\r\n');
    } else if (isNode) {
      write('\r\nNode Commands: crictl ps, journalctl -u k3s, df -h, free -m, whoami, uname -a, clear, exit\r\n');
    } else {
      write('\r\nPod Commands: cat /etc/hosts, env, ps aux, ls -la, whoami, pwd, clear, exit\r\n');
    }
    return;
  }

  if (cmd === 'whoami') {
    write(`\r\n${isLocal ? 'yarick' : isNode ? 'root' : 'app'}\r\n`);
    return;
  }

  if (cmd === 'pwd') {
    write(`\r\n${isLocal ? '/home/yarick/my/myproject/kubiki' : isNode ? '/' : '/app'}\r\n`);
    return;
  }

  if (cmd === 'hostname') {
    write(`\r\n${isLocal ? 'localhost' : resourceName || 'k8s-node'}\r\n`);
    return;
  }

  if (cmd === 'uname' || cmd === 'uname -a') {
    write('\r\nLinux localhost 6.13.0-custom #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n');
    return;
  }

  if (cmd === 'date') {
    write(`\r\n${new Date().toString()}\r\n`);
    return;
  }

  if (cmd === 'ls' || cmd === 'ls -la' || cmd === 'ls -l') {
    if (isLocal) {
      write('\r\ntotal 56\r\ndrwxr-xr-x 12 yarick users  4096 Oct 19 23:40 .\r\ndrwxr-xr-x  6 yarick users  4096 Oct 19 12:00 ..\r\n-rw-r--r--  1 yarick users  1420 Oct 19 21:10 Cargo.toml\r\n-rw-r--r--  1 yarick users 28540 Oct 19 21:10 Cargo.lock\r\ndrwxr-xr-x  4 yarick users  4096 Oct 19 20:30 crates\r\ndrwxr-xr-x  8 yarick users  4096 Oct 19 22:50 node_modules\r\n-rw-r--r--  1 yarick users  1890 Oct 19 22:15 package.json\r\n-rw-r--r--  1 yarick users 94210 Oct 19 22:15 pnpm-lock.yaml\r\ndrwxr-xr-x  2 yarick users  4096 Oct 19 19:10 public\r\ndrwxr-xr-x  8 yarick users  4096 Oct 19 23:30 src\r\n-rw-r--r--  1 yarick users   620 Oct 19 18:00 tsconfig.json\r\n-rw-r--r--  1 yarick users  1240 Oct 19 22:30 vite.config.ts\r\n');
    } else if (isNode) {
      write('\r\nbin  boot  dev  etc  home  lib  lib64  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var\r\n');
    } else {
      write('\r\nDockerfile  app.js  config.json  node_modules  package.json  src\r\n');
    }
    return;
  }

  if (parts[0] === 'kubectl') {
    if (parts[1] === 'version') {
      write('\r\nClient Version: v1.35.5+k3s1\r\nServer Version: v1.35.5+k3s1 (default)\r\n');
      return;
    }
    if (parts[1] === 'config' && parts[2] === 'get-contexts') {
      write('\r\nCURRENT   NAME      CLUSTER   AUTHINFO   NAMESPACE\r\n*         default   default   default    default\r\n');
      return;
    }
    if (parts[1] === 'get') {
      const kindWanted = (parts[2] ?? '').replace(/s$/, '').toLowerCase();
      if (kindWanted === 'node' || kindWanted === 'no') {
        write('\r\nNAME       STATUS   ROLES                  AGE   VERSION\r\ndefault    Ready    control-plane,master   3d    v1.35.5+k3s1\r\n');
        return;
      }
      const map: Record<string, string> = {
        pod: 'Pod',
        po: 'Pod',
        deploy: 'Deployment',
        deployment: 'Deployment',
        svc: 'Service',
        service: 'Service',
        cm: 'ConfigMap',
        configmap: 'ConfigMap',
        secret: 'Secret',
      };
      const resolved = map[kindWanted];
      if (!resolved) {
        write(`\r\nerror: unknown resource "${parts[2] ?? ''}" (try pods|nodes|deployments|services|configmaps|secrets)\r\n`);
        return;
      }
      const nsIdx = parts.indexOf('-n');
      const ns = nsIdx >= 0 ? parts[nsIdx + 1] : undefined;
      if (resolved === 'Pod') {
        write('\r\n' + PODS_LINE(ns ? pods.filter((p) => p.namespace === ns) : pods));
        return;
      }
      write(`\r\nShowing ${resolved}s in namespace ${ns || 'all'}\r\n`);
      return;
    }
  }

  write(`\r\n${cmd}: command executed\r\n`);
}

/* ------------------------------------------------------------------ */
/* Port Forwarding Session Pane                                        */
/* ------------------------------------------------------------------ */
