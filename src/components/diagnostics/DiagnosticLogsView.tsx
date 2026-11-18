import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Copy, Download, Pause, Play, ScrollText, Trash2, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Select } from '../ui/Select';
import { diagnostics, DIAGNOSTIC_CAPACITY } from '../../core/diagnostics/collector';
import type { DiagnosticRecord } from '../../core/diagnostics/model';
import { nativeDiagnostics } from '../../core/diagnostics/runtime';
import { useUiStore } from '../../state/ui_store';
import { uiFactor } from '../../core/appearance';
import './diagnostics.css';
const noSubscribe = () => () => {};
const identity = (record: DiagnosticRecord) => `${record.source}:${record.sequence}:${record.timestamp}`;
function exportRecords() {
  const records = diagnostics.getRecords();
  const blob = new Blob([records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `kubiki-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DiagnosticLogsView({ visible = true }: { visible?: boolean }) {
  const state = useSyncExternalStore(visible ? diagnostics.subscribe : noSubscribe, diagnostics.getSnapshot);
  const scale = useUiStore(s => s.uiScale);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState(1);
  const [source, setSource] = useState('all');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<readonly DiagnosticRecord[]>([]);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<DiagnosticRecord | null>(null);
  const [notice, setNotice] = useState('');
  const [clearing, setClearing] = useState(false);
  const deferredQuery = useDeferredValue(query.toLowerCase().trim());
  const displayed = paused ? frozen : state.records;
  const rows = useMemo(() => displayed.filter(record => record.severityNumber >= level && (source === 'all' || record.source === source)
    && (!deferredQuery || [record.eventName, record.traceId, ...Object.values(record.attributes)].join(' ').toLowerCase().includes(deferredQuery))), [displayed, level, source, deferredQuery]);
  const warningCount = useMemo(() => state.records.filter(record => record.severityNumber >= 13).length, [state.records]);
  const scroll = useRef<HTMLDivElement>(null);
  const rowHeight = 27 * uiFactor(scale);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => rowHeight,
    paddingStart: rowHeight, overscan: 12, getItemKey: index => identity(rows[index]) });
  useEffect(() => { virtual.measure(); }, [rowHeight, virtual]);
  useEffect(() => {
    if (visible && follow && !paused && rows.length) virtual.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows, follow, paused, visible, virtual]);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('Copied.'); }
    catch { setNotice('Clipboard unavailable. Select the text to copy it.'); }
  }
  async function clearSaved() {
    setClearing(true); setNotice(''); setSelected(null);
    try { await nativeDiagnostics.clearSaved(); setNotice('Saved diagnostic files cleared. Capture continues.'); }
    catch { setNotice('Saved files could not be cleared. Retry when the native output queue is available.'); }
    finally { setClearing(false); }
  }
  return <section className="diagnostic-view" aria-label="Application Logs" style={{ '--diag-row-height': `${rowHeight}px` } as CSSProperties}>
    <header className="diagnostic-heading">
      <div><div className="diagnostic-eyebrow"><span className="diagnostic-live" /> Developer tools · local capture</div>
        <h1><ScrollText size={18} /> Application Logs</h1>
        <p>Operations, timings and failures across the interface and native backend.</p></div>
      <div className="diagnostic-actions">
        <Button size="sm" onClick={() => { if (!paused) setFrozen(state.records); setPaused(!paused); }} aria-pressed={paused}>
          {paused ? <Play size={13} /> : <Pause size={13} />}{paused ? 'Resume view' : 'Pause view'}</Button>
        <Button size="sm" onClick={exportRecords} disabled={!state.records.length}><Download size={13} />Export JSONL</Button>
        <Button size="sm" onClick={() => { diagnostics.clear(); setFrozen([]); setSelected(null); }}><Trash2 size={13} />Clear buffer</Button>
      </div>
    </header>
    <div className="diagnostic-counters" aria-label="Diagnostic capture counters">
      <div><span>Buffered</span><strong>{state.records.length.toLocaleString()}<small> / {DIAGNOSTIC_CAPACITY.toLocaleString()}</small></strong></div>
      <div><span>Warnings & errors</span><strong className={warningCount ? 'diagnostic-warning' : ''}>{warningCount.toLocaleString()}</strong></div>
      <div><span>Rate limited</span><strong>{state.rateDropped.toLocaleString()}</strong></div>
      <div><span>Output queue drops</span><strong>{(state.transportDropped + state.nativeQueueDropped).toLocaleString()}</strong></div>
    </div>
    <div className="diagnostic-toolbar">
      <SearchInput value={query} onChange={setQuery} placeholder="Filter events, operations, context or trace ID…" className="diagnostic-search" size="sm" />
      <Select aria-label="Diagnostic minimum severity" value={level} onChange={event => setLevel(Number(event.target.value))}>
        <option value={1}>All levels</option><option value={5}>Debug and above</option><option value={9}>Info and above</option><option value={13}>Warnings and errors</option><option value={17}>Errors only</option>
      </Select>
      <Select aria-label="Diagnostic source" value={source} onChange={event => setSource(event.target.value)}>
        <option value="all">All sources</option><option value="frontend">Frontend</option><option value="native">Native</option>
      </Select>
      <Button size="sm" variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => setFollow(!follow)}>Follow</Button>
    </div>
    {paused && <p role="status" className="diagnostic-notice">View paused. Collection, console output and native file output continue.</p>}
    {notice && <p role="status" className="diagnostic-notice">{notice}</p>}
    {state.nativeIoFailures > 0 && <p role="status" className="diagnostic-notice diagnostic-warning">Native output errors: {state.nativeIoFailures}. The in-memory capture remains available; check file permissions or console output.</p>}
    <div className="diagnostic-content">
      <div className="diagnostic-scroll" ref={scroll} role="table" aria-label="Application diagnostic events" aria-rowcount={rows.length + 1}
        onScroll={() => { const el = scroll.current; if (el && !paused) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 2); }}>
        <div className="diagnostic-canvas" style={{ height: Math.max(virtual.getTotalSize(), rowHeight) }}>
          <div className="diagnostic-row diagnostic-columns" role="row" aria-rowindex={1}>
            {['Time · UTC', 'Level', 'Source', 'Event / operation', 'Duration', 'Context', 'Resource', 'Trace ID'].map(label => <span role="columnheader" key={label}>{label}</span>)}
          </div>
          <div role="rowgroup">{virtual.getVirtualItems().map(item => {
            const record = rows[item.index]; const fields = record.attributes;
            return <div key={item.key} role="row" tabIndex={0} aria-rowindex={item.index + 2} aria-selected={selected && identity(selected) === identity(record) || false}
              className="diagnostic-row diagnostic-event" style={{ transform: `translateY(${item.start}px)` }}
              onClick={() => setSelected(record)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(record); } }}>
              <span role="cell" title={record.timestamp}>{record.timestamp.slice(11, 23)}</span>
              <span role="cell" className={`diagnostic-level diagnostic-level-${record.severityText.toLowerCase()}`}>{record.severityText}</span>
              <span role="cell">{record.source}</span>
              <span role="cell" className="diagnostic-operation" title={String(fields.operation ?? fields['http.route'] ?? record.eventName)}><b>{record.eventName}</b>{fields.operation && <em>{fields.operation}</em>}{fields['http.request.method'] && <em>{fields['http.request.method']} {fields['http.response.status_code'] ?? fields['k8s.operation']}</em>}{fields['error.code'] && <em className="diagnostic-warning">{fields['error.code']}</em>}</span>
              <span role="cell">{typeof fields.duration_ms === 'number' ? `${fields.duration_ms.toFixed(1)} ms` : '—'}</span>
              <span role="cell" title={String(fields.context ?? '')}>{fields.context ?? '—'}</span>
              <span role="cell" title={String(fields['resource.kind'] ?? fields['k8s.resource.plural'] ?? '')}>{fields['resource.kind'] ?? fields['k8s.resource.plural'] ?? '—'}</span>
              <span role="cell" title={record.traceId}>{record.traceId?.slice(0, 10) ?? '—'}</span>
            </div>;
          })}</div>
        </div>
        {!rows.length && <div className="diagnostic-empty"><ScrollText size={25} /><strong>{state.records.length ? 'No matching events' : 'Waiting for application events'}</strong><p>{state.records.length ? 'Change the severity, source or search filter.' : 'Navigate to a resource, refresh data or reproduce the issue. Events appear here automatically.'}</p></div>}
      </div>
      {selected && <aside className="diagnostic-detail" aria-label="Diagnostic event details">
        <header><strong>{selected.eventName}</strong><Button size="sm" variant="ghost" aria-label="Close diagnostic details" onClick={() => setSelected(null)}><X size={14} /></Button></header>
        <div className="diagnostic-detail-actions"><Button size="sm" onClick={() => void copy(JSON.stringify(selected, null, 2))}><Copy size={12} />Copy record</Button>
          {selected.traceId && <Button size="sm" onClick={() => { setQuery(selected.traceId!); setLevel(1); setSource('all'); }}>Filter trace</Button>}</div>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
      </aside>}
    </div>
    <footer className="diagnostic-footer">
      <span>{rows.length.toLocaleString()} shown · {state.evicted.toLocaleString()} buffer evictions{state.nativeDropped > 0 ? ` · ${state.nativeDropped} native buffer/rate discards` : ''}</span>
      <span>Schema v1 · Console: [kubiki.diagnostics] · Payloads excluded{state.consoleFailures > 0 ? ` · ${state.consoleFailures} console failures` : ''}</span>
    </footer>
    <div className="diagnostic-journal">
      <div><span>{state.journalPath ? state.nativeFileReady ? 'Native JSONL journal' : 'Native journal pending / unavailable' : state.nativeAvailable ? 'Native output starting…' : 'Browser console and memory'} </span>
        {state.journalPath ? <code>{state.journalPath}</code> : <span>Export the buffer for offline inspection.</span>}</div>
      {state.journalPath && <div className="diagnostic-actions"><Button size="sm" variant="ghost" onClick={() => void copy(state.journalPath!)}><Copy size={12} />Copy path</Button><Button size="sm" variant="ghost" loading={clearing} onClick={() => void clearSaved()}>Clear saved logs</Button></div>}
    </div>
  </section>;
}
