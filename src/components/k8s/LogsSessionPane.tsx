import { useEffect, useMemo, useRef, useState } from 'react';
import { ContainerChoices } from './ContainerLaunchDialog';
import { LogsToolbar } from './LogsToolbar';
import { useSessionContainers } from './useSessionContainers';
import { LogBuffer, bumpLogTimestamp, type LogLine } from '../../core/utils/log_buffer';
import { parseStructuredLog, structuredFieldsText } from '../../core/utils/log_structured';
import { fetchLogSlice, type LogSliceParams } from '../../providers/tauri_logs';
import { resourceRef } from '../../core/resources/identity';
import { k8s } from '../../providers/k8s_provider';
import { useDockStore, type DockSession } from '../../state/dock_store';
import { LOG_POLL_PRESETS, useUiStore } from '../../state/ui_store';
import { Button } from '../ui/Button';
import { cx } from '../../core/utils/cx';

const LOG_TEMPLATES = [
  ['info', 'GET /api/v1/items 200 in {ms}ms'],
  ['info', 'metrics flushed to prometheus: points={ms}'],
  ['info', 'ingress connection accepted from 10.42.{n}.{n}'],
  ['warn', 'retry attempt {n} for upstream endpoint payment-api'],
  ['warn', 'slow query execution detected: 8{n}ms'],
  ['error', 'dial tcp 10.43.0.25:5432: connection refused (retrying in 2s)'],
  ['info', 'readiness probe probe HTTP 200 OK (container healthy)'],
  ['warn', 'grpc keepalive timeout probe missed ({n})'],
];


export function SessionContainerChoice({ session, shell = false, onContainerChange }: { session: DockSession; shell?: boolean; onContainerChange?: (name: string) => void }) {
  const { containers, recreated } = useSessionContainers(session, shell);
  return <div className="p-4 max-w-lg overflow-auto"><h3 className="text-sm font-medium mb-3">Choose container · {shell ? 'Shell' : 'Logs'}</h3>{recreated ? <p>This Pod was recreated. Open a new session from the current resource.</p> : <ContainerChoices containers={containers} shell={shell} onChoose={name => onContainerChange ? onContainerChange(name) : useDockStore.getState().updateSessionContainer(session.id, name)} />}</div>;
}
export function LogsSessionPane(props: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const { needsSelection } = useSessionContainers(props.session);
  return needsSelection ? <SessionContainerChoice session={props.session} onContainerChange={props.onContainerChange} /> : <LogsSessionContent {...props} />;
}

function LogsSessionContent({ session, visible = true, onContainerChange }: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const [error, setError] = useState('');
  const { containers, container: activeContainer, context, recreated, uid } = useSessionContainers(session);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  /* Session toggles initialized from the Logs page defaults in settings. */
  const [wrap, setWrap] = useState(() => useUiStore.getState().logsWrap);
  const [filter, setFilter] = useState('');
  const [showTimestamps, setShowTimestamps] = useState(() => useUiStore.getState().logsTimestamps);
  const [structured, setStructured] = useState(() => useUiStore.getState().logsStructured);
  const [pollMs, setPollMs] = useState(() => useUiStore.getState().logsPollMs);

  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);
  const seqRef = useRef(1);
  const native = !k8s.demo && '__TAURI_INTERNALS__' in window;
  const [previous, setPrevious] = useState(false);
  const [tail, setTail] = useState(500);
  const [since, setSince] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState('Connecting');
  const [truncated, setTruncated] = useState(false);
  const bufferRef = useRef(new LogBuffer());
  const outputRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /* Keeps the loop on the live cadence without tearing down scrollback. */
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;
  /* Resume point after Clear: the next poll fetches only lines past it. */
  const clearedWatermark = useRef('');

  const sourceKey = JSON.stringify([native, session.id, session.resourceName, session.namespace, uid, activeContainer, context, previous, tail, since, generation]);
  const bufferSource = useRef('');

  /* Lens-style reads: a bounded initial slice, then cadence polls that resume
     after the newest timestamp and drop the refetched overlap by signature. */
  useEffect(() => {
    if (bufferSource.current !== sourceKey) {
      bufferSource.current = sourceKey;
      bufferRef.current = new LogBuffer();
      setLines([]); setError(''); setTruncated(false);
      clearedWatermark.current = ''; pinned.current = true;
    }
    if (paused) { setPhase('Paused'); return; }
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = bufferRef.current;
    setPhase('Connecting');
    let retries = 0;

    const run = async () => {
      if (cancelled) return;
      if (!visible) { timer = setTimeout(run, pollRef.current); return; }
      try {
        if (k8s.demo) {
          const [level, template] = LOG_TEMPLATES[seqRef.current % LOG_TEMPLATES.length];
          const msg = `[demo ${session.resourceName}/${activeContainer}] ` + template.replace('{ms}', '42').replace(/\{n\}/g, '3');
          const line = { t: new Date().toISOString().slice(11, 23), level, msg, seq: seqRef.current++ };
          setLines((current) => [...current, line].slice(-500));
        } else {
          if (recreated) throw new Error('The Pod was recreated. Open the current Pod to read its logs.');
          if (!context || !session.resourceName || !session.namespace) throw new Error('Select a Pod and namespace to view logs.');
          if (!activeContainer) throw new Error('Select a container to view logs.');
          let text: string;
          let replace = false;
          if (native) {
            if (!uid) throw new Error('A Pod with UID is required. Reopen logs from the current Pod.');
            const resource = resourceRef(context, { kind: 'Pod', apiVersion: 'v1', uid, name: session.resourceName, namespace: session.namespace });
            const last = buffer.lines[buffer.lines.length - 1]?.t || clearedWatermark.current;
            const params: LogSliceParams = last
              ? { resource, container: activeContainer, previous, since_time: last }
              : { resource, container: activeContainer, previous, tail_lines: tail, since_seconds: since || undefined };
            text = await fetchLogSlice(params);
          } else {
            text = await k8s.getLogs(context, session.resourceName, session.namespace, activeContainer);
            replace = true;
          }
          if (cancelled) return;
          if (replace) {
            /* Browser mode returns a whole snapshot; it always replaces history. */
            buffer.clear();
            buffer.push([...new TextEncoder().encode(text)], true);
          } else {
            /* The overlap from the last second is refetched; drop exact repeats. */
            const decoded = new LogBuffer();
            decoded.push([...new TextEncoder().encode(text)], true);
            const seen = new Set(buffer.lines.map((l) => `${l.t}\u0000${l.msg}`));
            for (const line of decoded.lines) {
              const signature = `${line.t}\u0000${line.msg}`;
              if (seen.has(signature)) continue;
              seen.add(signature);
              buffer.addLine(line.t ? `${line.t} ${line.msg}` : line.msg);
            }
          }
          setLines([...buffer.lines]); setTruncated(buffer.truncated);
          retries = 0;
          setError('');
          if (native && previous) { setPhase('Snapshot'); return; }
          setPhase(`Polling every ${Math.round(pollRef.current / 1000)}s`);
        }
      } catch (read) {
        if (cancelled) return;
        retries++;
        const message = read instanceof Error ? read.message : String(read);
        setPhase(retries >= 3 ? 'Failed' : `Stalled · retry ${retries} of 3`);
        setError(retries >= 3 ? `${message} · press Reconnect logs to retry` : message);
        if (retries >= 3) return;
      }
      if (cancelled) return;
      /* Failures back off (1×, 2×, 4×) and stop after three consecutive misses. */
      timer = setTimeout(run, pollRef.current * [1, 2, 4][Math.min(retries, 2)]);
    };
    void run();
    const stop = () => { cancelled = true; if (timer) clearTimeout(timer); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [sourceKey, paused, recreated, visible]);

  useEffect(() => {
    const output = outputRef.current;
    if (visible && pinned.current && output) output.scrollTop = output.scrollHeight;
  }, [lines, visible, filter]);

  const [filterRegex, setFilterRegex] = useState(false);
  const shown = useMemo(() => {
    if (!filter.trim()) return lines;
    if (filterRegex) {
      try {
        const rx = new RegExp(filter.trim(), 'i');
        return lines.filter((l) => rx.test(l.level + ' ' + l.msg));
      } catch {
        return [];
      }
    }
    const q = filter.toLowerCase();
    return lines.filter((l) => (l.level + ' ' + l.msg).toLowerCase().includes(q));
  }, [lines, filter, filterRegex]);
  /* JSON lines turn into message + k=v fields only while the toggle is on. */
  const parsedLines = useMemo(() => {
    const parsed = new Map<number, ReturnType<typeof parseStructuredLog>>();
    if (!structured) return parsed;
    for (const line of shown) parsed.set(line.seq, parseStructuredLog(line.msg));
    return parsed;
  }, [shown, structured]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      {error && <div role="alert" className="px-3 py-1 text-[var(--status-danger)] text-xs">{error}</div>}
      <div className="px-3 py-0.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{k8s.demo ? `Simulated logs · poll every ${Math.round(pollMs / 1000)}s` : native ? `${phase} · ${previous ? 'previous container snapshot' : `initial tail ${tail}`} · history up to 1000 lines` : `Browser snapshot · latest 500 lines · refresh every ${Math.round(pollMs / 1000)}s`}{truncated && ' · older or oversized output discarded'}</div>
      <LogsToolbar sourceControls={native ? <div className="border-t border-[var(--border-default)] p-2 space-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={previous} onChange={(event) => setPrevious(event.target.checked)} />Previous container instance</label>
        <label className="flex items-center justify-between gap-2">Initial tail<select aria-label="Initial log tail" value={tail} onChange={(event) => setTail(Number(event.target.value))} className="ide-select">{[100, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Since<select aria-label="Log time range" value={since} onChange={(event) => setSince(Number(event.target.value))} className="ide-select">{[[0, 'Any time'], [300, '5 minutes'], [3600, '1 hour'], [86400, '24 hours']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Poll frequency<select aria-label="Log poll frequency" value={pollMs} onChange={(event) => { const value = Number(event.target.value); setPollMs(value); useUiStore.getState().setLogsPollMs(value); }} className="ide-select">{LOG_POLL_PRESETS.map((value) => <option key={value} value={value}>{value / 1000}s</option>)}</select></label>
        <Button size="sm" onClick={() => { setPaused(false); setGeneration((value) => value + 1); }}>Reconnect logs</Button>
        <p className="text-[var(--text-muted)]">Reads reload the recent tail, then poll only lines after the newest timestamp. Previous logs are a snapshot.</p>
      </div> : undefined} name={session.resourceName} namespace={session.namespace} context={context} containers={containers} container={activeContainer}
        onContainer={onContainerChange ?? ((name) => updateSessionContainer(session.id, name))} filter={filter} onFilter={setFilter} isRegex={filterRegex} onToggleRegex={setFilterRegex}
        paused={paused} onPause={() => setPaused(!paused)} timestamps={showTimestamps} onTimestamps={() => setShowTimestamps(!showTimestamps)} wrap={wrap} onWrap={() => setWrap(!wrap)} structured={structured} onStructured={() => setStructured(!structured)}
        onClear={() => {
          const buffer = bufferRef.current; const last = buffer.lines[buffer.lines.length - 1]?.t;
          clearedWatermark.current = last ? bumpLogTimestamp(last) : '';
          buffer.clear(); setLines([]); setTruncated(false);
        }} onDownload={() => {
          const blob = new Blob([lines.map((l) => `${l.t} ${l.msg}`).join('\n')], { type: 'text/plain' });
          const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.resourceName}-${activeContainer}.log`; anchor.click(); URL.revokeObjectURL(url);
        }} />

      {/* Log Output Body */}
      <div ref={outputRef} onScroll={() => { const el = outputRef.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className="flex-1 min-h-0 overflow-auto kubiki-scrollbar bg-[var(--bg-canvas)] px-3 py-2 select-text">
        {shown.length === 0 ? (
          <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] font-mono py-4 text-center">
            No logs matching filter “{filter}” for {session.resourceName}
          </div>
        ) : (
          <div className="font-mono text-[length:calc(11px*var(--ui-factor))] leading-[1.5]">
            {shown.map((l) => {
              const parsed = structured ? parsedLines.get(l.seq) ?? null : null;
              const level = parsed?.level ?? l.level;
              const message = parsed?.message ?? l.msg;
              return (
                <div
                  key={l.seq}
                  className={cx(
                    wrap ? 'whitespace-pre-wrap' : 'whitespace-nowrap',
                    level === 'error' ? 'text-[#e05555]' : level === 'warn' ? 'text-[#e5b742]' : level === 'debug' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
                  )}
                >
                  {showTimestamps && (
                    <span className="text-[var(--text-muted)] select-none pr-2 font-mono">{l.t}</span>
                  )}
                  <span
                    className={cx(
                      'select-none pr-2 font-semibold',
                      level === 'error' ? 'text-[var(--status-danger)]' : level === 'warn' ? 'text-[var(--status-warn)]' : level === 'debug' ? 'text-[var(--text-muted)]' : 'text-[var(--status-ok)]'
                    )}
                  >
                    {level.toUpperCase().padEnd(5)}
                  </span>
                  <span>{message}{parsed?.fields.length ? <span className="text-[var(--text-muted)]"> {structuredFieldsText(parsed.fields)}</span> : null}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
