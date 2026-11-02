import { Select } from '../ui/Select';
import './settings.css';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Search, X } from 'lucide-react';
import packageJson from '../../../package.json';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Checkbox } from '../ui/Checkbox';
import { UpdateSettings } from '../updates/AppUpdates';
import { TerminalFontSettings } from '../TerminalFontSettings';
import { LogTimeZoneSelect } from '../k8s/LogTimeZoneSelect';
import { toast } from '../../state/notifications_store';
import { useClusterStore } from '../../state/cluster_store';
import { useTableViewStore } from '../../state/table_view_store';
import { k8s } from '../../providers/k8s_provider';
import {
  DEFAULT_SCROLLBACK,
  LOG_BUFFER_PRESETS,
  LOG_POLL_PRESETS,
  LOG_TAIL_PRESETS,
  TERMINAL_ACK_TIMEOUT_PRESETS,
  TERMINAL_SCROLLBACK_PRESETS,
  useUiStore,
} from '../../state/ui_store';
import { DEFAULT_TERMINAL_FONT } from '../../core/terminal_appearance';
import { APPEARANCE_LIMITS, DEFAULT_APPEARANCE } from '../../core/appearance';
import { TOPOLOGY_UPDATE_INTERVALS } from '../../core/resources/topology_rendering';
import { cx } from '../../core/utils/cx';
import { useAiStore } from '../../domains/ai/store';
import { AgentSettings, availableAiSettingsPages, type AgentSettingsPage } from '../../domains/ai/components/AgentSettings';
import { fuzzyRanges } from '../../core/utils/fuzzy';
import {
  entryMatches, filterPages, findEntry, findPage, firstMatchingPage,
  type SettingsEntry, type SettingsPageDef, type SettingsPageId,
} from './registry';

const APP_VERSION = packageJson.version;

/* ------------------------------------------------------------------ */
/* Shared search plumbing                                              */
/* ------------------------------------------------------------------ */

const SearchContext = createContext('');

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const ranges = q ? fuzzyRanges(q, text) : null;
  if (!ranges) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(<span key={`t${index}`}>{text.slice(cursor, start)}</span>);
    parts.push(<mark key={`m${index}`} className="rounded-[2px] bg-[rgba(229,183,66,0.32)] text-inherit">{text.slice(start, end)}</mark>);
    cursor = end;
  });
  parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

/* ------------------------------------------------------------------ */
/* Content primitives                                                  */
/* ------------------------------------------------------------------ */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="settings-page-title">{children}</h2>;
}

function SettingsGroup({ title, entries, children, collapsible = false }: { title: string; entries: string[]; children: React.ReactNode; collapsible?: boolean }) {
  const query = useContext(SearchContext).trim();
  if (query && !entries.some(id => entryMatches(findEntry(id), query))) return null;
  return collapsible
    ? <details className="settings-group" open={query ? true : undefined}><summary>{title}</summary>{children}</details>
    : <section className="settings-group" aria-label={title}><h3>{title}</h3>{children}</section>;
}

interface RowProps {
  entry: SettingsEntry;
  children: React.ReactNode;
  wide?: boolean;
  below?: React.ReactNode;
}

function Row({ entry, wide, below, children }: RowProps) {
  const query = useContext(SearchContext);
  if (query.trim() && !entryMatches(entry, query)) return null;
  const toggle = React.isValidElement(children) && children.type === Checkbox;
  const controlId = `settings-control-${entry.id}`;
  const label = <Highlight text={entry.label} query={query} />;
  const control = toggle ? React.cloneElement(children as React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>, {
    id: controlId, 'aria-describedby': entry.description ? `${controlId}-help` : undefined,
  }) : children;
  return <div id={`settings-row-${entry.id}`} className={cx('settings-row', wide && 'settings-row-wide')} data-control={toggle ? 'toggle' : undefined}>
    <div className="settings-row-label">
      {toggle ? <label htmlFor={controlId}>{label}</label> : <div>{label}</div>}
      {entry.description && <p id={`${controlId}-help`} className="settings-hint"><Highlight text={entry.description} query={query} /></p>}
    </div>
    <div className="settings-row-control">{control}</div>
    {below && <div className="settings-row-below">{below}</div>}
    {entry.details && <details className="settings-row-below settings-detail" open={query.trim() ? true : undefined}><summary>Session behavior</summary><p className="settings-hint">{entry.details}</p></details>}
  </div>;
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel, disabled }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="settings-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-[calc(26px*var(--ui-factor))] px-2.5 text-[length:calc(11px*var(--ui-factor))] transition-colors disabled:opacity-50',
            value === option.value ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NumberField({ label, value, min, max, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  return (
    <input
      aria-label={label}
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => {
        if (event.target.value) {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }
      }}
      className="ide-select w-20"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function AppearancePage({ sectionTitle }: { sectionTitle: string }) {
  const density = useUiStore((s) => s.density);
  const uiScale = useUiStore((s) => s.uiScale);
  const defaultRightTab = useUiStore((s) => s.defaultRightTab);
  const setDensity = useUiStore((s) => s.setDensity);
  const setUiScale = useUiStore((s) => s.setUiScale);
  const setDefaultRightTab = useUiStore((s) => s.setDefaultRightTab);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row
        entry={findEntry('appearance.ui-scale')}
        below={
          <div className="flex flex-wrap gap-1 pt-2" aria-label="Interface scale presets">
            {[100, 110, 125, 150, 175, 200].map((scale) => (
              <button
                key={scale}
                type="button"
                aria-label={`Set interface scale to ${scale}%`}
                aria-pressed={uiScale === scale}
                onClick={() => setUiScale(scale)}
                className={cx(
                  'px-2 py-1 rounded border text-xs transition-colors',
                  uiScale === scale ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                )}
              >
                {scale}%{scale === DEFAULT_APPEARANCE.uiScale ? ' · default' : ''}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <input
            aria-label="Interface scale"
            type="range"
            min={APPEARANCE_LIMITS.uiScale[0]}
            max={APPEARANCE_LIMITS.uiScale[1]}
            step={5}
            value={uiScale}
            onChange={(event) => setUiScale(Number(event.target.value))}
            className="w-28 accent-[var(--accent)]"
          />
          <output className="w-12 text-right font-mono text-xs">{uiScale}%</output>
        </div>
      </Row>
      <Row entry={findEntry('appearance.row-density')}>
        <Segmented
          ariaLabel="Row density"
          value={density}
          onChange={setDensity}
          options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]}
        />
      </Row>
      <Row entry={findEntry('appearance.details-tab')}>
        <Segmented
          ariaLabel="Default details tab"
          value={defaultRightTab}
          onChange={setDefaultRightTab}
          options={[{ value: 'overview', label: 'Overview' }, { value: 'yaml', label: 'YAML' }]}
        />
      </Row>
      <Row entry={findEntry('appearance.reset-tables')}>
        <Button
          size="sm"
          onClick={() => {
            useUiStore.getState().resetAllTableLayouts();
            useTableViewStore.getState().resetAll();
            toast.success('All table columns and filters reset to defaults');
          }}
        >
          <RotateCcw size="calc(12px * var(--ui-factor))" /> Reset table columns & filters
        </Button>
      </Row>
    </div>
  );
}

function TopologyPage({ sectionTitle }: { sectionTitle: string }) {
  const ui = useUiStore();
  const fast = ui.topologyPerformanceMode === 'performance';
  return <div>
    <SectionTitle>{sectionTitle}</SectionTitle>
    <Row entry={findEntry('topology.performance')} below={<p className="settings-hint">{fast
      ? 'Uses compact nodes and straight connections. Turns off shadows, animations, labels, grid and minimap.'
      : ui.topologyPerformanceMode === 'quality' ? 'Shows node shadows.' : 'Hides node shadows.'}</p>}>
      <Segmented ariaLabel="Topology rendering profile" value={ui.topologyPerformanceMode} onChange={ui.setTopologyPerformanceMode}
        options={[{ value: 'quality', label: 'Quality' }, { value: 'balanced', label: 'Balanced' }, { value: 'performance', label: 'Performance' }]} />
    </Row>
    <SettingsGroup title="Layout" entries={['topology.grouping', 'topology.edges']}>
    <Row entry={findEntry('topology.grouping')}>
      <Segmented ariaLabel="Cluster layout grouping" value={ui.topologyGrouping} onChange={ui.setTopologyGrouping}
        options={[{ value: 'namespace', label: 'Namespace' }, { value: 'flat', label: 'Flat' }]} />
    </Row>
    <Row entry={findEntry('topology.edges')}>
      <Select aria-label="Topology connection style" className="ide-select" disabled={fast} value={fast ? 'straight' : ui.topologyEdgeStyle} onChange={event => ui.setTopologyEdgeStyle(event.target.value as typeof ui.topologyEdgeStyle)}>
        <option value="smooth">Editable routes</option><option value="bezier">Curved</option><option value="straight">Straight</option>
      </Select>
    </Row>
    </SettingsGroup>
    <SettingsGroup title="Display" entries={['topology.animations', 'topology.labels', 'topology.minimap', 'topology.background']}>
    <Row entry={findEntry('topology.animations')}>
      <Checkbox aria-label="Animate topology connections" disabled={fast} checked={!fast && ui.topologyAnimations} onChange={event => ui.setTopologyAnimations(event.target.checked)} />
    </Row>
    <Row entry={findEntry('topology.labels')}>
      <Checkbox aria-label="Topology connection labels" disabled={fast} checked={!fast && ui.topologyShowEdgeLabels} onChange={event => ui.setTopologyShowEdgeLabels(event.target.checked)} />
    </Row>
    <Row entry={findEntry('topology.minimap')}>
      <Checkbox aria-label="Topology canvas minimap" disabled={fast} checked={!fast && ui.topologyShowMinimap} onChange={event => ui.setTopologyShowMinimap(event.target.checked)} />
    </Row>
    <Row entry={findEntry('topology.background')}>
      <Checkbox aria-label="Topology background grid" disabled={fast} checked={!fast && ui.topologyShowBackground} onChange={event => ui.setTopologyShowBackground(event.target.checked)} />
    </Row>
    </SettingsGroup>
    <Row entry={findEntry('topology.updates')}>
      <Select aria-label="Topology live redraw interval" className="ide-select" value={fast ? Math.max(3000, ui.topologyUpdateIntervalMs) : ui.topologyUpdateIntervalMs} onChange={event => ui.setTopologyUpdateIntervalMs(Number(event.target.value))}>
        {TOPOLOGY_UPDATE_INTERVALS.filter(value => !fast || value >= 3000).map(value => <option key={value} value={value}>{value < 1000 ? `${value} ms` : `${value / 1000} s`}</option>)}
      </Select>
    </Row>
  </div>;
}

function EditorPage({ sectionTitle }: { sectionTitle: string }) {
  const editorFontSize = useUiStore((s) => s.editorFontSize);
  const setEditorFontSize = useUiStore((s) => s.setEditorFontSize);
  const yamlCleanView = useUiStore((s) => s.yamlCleanView);
  const setYamlCleanView = useUiStore((s) => s.setYamlCleanView);
  const yamlHideManagedFields = useUiStore((s) => s.yamlHideManagedFields);
  const setYamlHideManagedFields = useUiStore((s) => s.setYamlHideManagedFields);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('editor.font-size')}>
        <NumberField label="YAML editor font size" value={editorFontSize} min={10} max={24} onCommit={setEditorFontSize} />
      </Row>
      <Row entry={findEntry('editor.default-view')}>
        <Segmented
          ariaLabel="Default YAML document view"
          value={yamlCleanView ? 'clean' : 'full'}
          onChange={(value) => setYamlCleanView(value === 'clean')}
          options={[{ value: 'clean', label: 'Clean' }, { value: 'full', label: 'Full' }]}
        />
      </Row>
      <Row entry={findEntry('editor.hide-managed-fields')}>
        <Checkbox
          aria-label="Hide managedFields by default"
          checked={yamlHideManagedFields}
          onChange={(event) => setYamlHideManagedFields(event.target.checked)}
        />
      </Row>
    </div>
  );
}

function TerminalPage({ sectionTitle }: { sectionTitle: string }) {
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useUiStore((s) => s.setTerminalFontSize);
  const terminalScrollback = useUiStore((s) => s.terminalScrollback);
  const setTerminalScrollback = useUiStore((s) => s.setTerminalScrollback);
  const terminalAckTimeoutSecs = useUiStore((s) => s.terminalAckTimeoutSecs);
  const setTerminalAckTimeoutSecs = useUiStore((s) => s.setTerminalAckTimeoutSecs);
  const scrollbackOptions = TERMINAL_SCROLLBACK_PRESETS.includes(terminalScrollback)
    ? TERMINAL_SCROLLBACK_PRESETS
    : [...TERMINAL_SCROLLBACK_PRESETS, terminalScrollback].sort((a, b) => a - b);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('terminal.font-size')}>
        <NumberField label="Terminal font size" value={terminalFontSize} min={10} max={24} onCommit={setTerminalFontSize} />
      </Row>
      <Row entry={findEntry('terminal.typeface')} wide>
        <TerminalFontSettings />
      </Row>
      <Row entry={findEntry('terminal.scrollback')}>
        <Select
          aria-label="Terminal scrollback limit"
          className="ide-select w-32"
          value={terminalScrollback}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) setTerminalScrollback(next);
          }}
        >
          {scrollbackOptions.map((lines) => (
            <option key={lines} value={lines}>{lines.toLocaleString('en-US')} lines</option>
          ))}
        </Select>
      </Row>
      <Row entry={findEntry('terminal.output-timeout')}>
        <Select
          aria-label="Output processing timeout"
          className="ide-select w-40"
          value={terminalAckTimeoutSecs}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) setTerminalAckTimeoutSecs(next);
          }}
        >
          {TERMINAL_ACK_TIMEOUT_PRESETS.map((seconds) => (
            <option key={seconds} value={seconds}>{seconds === 0 ? 'No timeout' : seconds === 60 ? '1 minute' : seconds === 300 ? '5 minutes' : `${seconds} seconds`}</option>
          ))}
        </Select>
      </Row>
    </div>
  );
}

function LogsPage({ sectionTitle }: { sectionTitle: string }) {
  const logsMode = useUiStore((s) => s.logsMode);
  const setLogsMode = useUiStore((s) => s.setLogsMode);
  const logsPollMs = useUiStore((s) => s.logsPollMs);
  const setLogsPollMs = useUiStore((s) => s.setLogsPollMs);
  const logsWrap = useUiStore((s) => s.logsWrap);
  const setLogsWrap = useUiStore((s) => s.setLogsWrap);
  const logsTimestamps = useUiStore((s) => s.logsTimestamps);
  const setLogsTimestamps = useUiStore((s) => s.setLogsTimestamps);
  const logsColorLevels = useUiStore((s) => s.logsColorLevels);
  const setLogsColorLevels = useUiStore((s) => s.setLogsColorLevels);
  const logsStructured = useUiStore((s) => s.logsStructured);
  const setLogsStructured = useUiStore((s) => s.setLogsStructured);
  const logsDefaultTail = useUiStore((s) => s.logsDefaultTail);
  const setLogsDefaultTail = useUiStore((s) => s.setLogsDefaultTail);
  const logsMaxBufferLines = useUiStore((s) => s.logsMaxBufferLines);
  const setLogsMaxBufferLines = useUiStore((s) => s.setLogsMaxBufferLines);
  const logsScrollStickiness = useUiStore((s) => s.logsScrollStickiness);
  const setLogsScrollStickiness = useUiStore((s) => s.setLogsScrollStickiness);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <p className="settings-hint">Changes apply to all log panes.</p>
      <SettingsGroup title="Updates" entries={['logs.mode', 'logs.poll-interval']}>
      <Row entry={findEntry('logs.mode')}>
        <Segmented
          ariaLabel="Log updates"
          value={logsMode}
          onChange={(v) => setLogsMode(v as 'poll' | 'watch')}
          options={[
            { value: 'poll', label: 'Polling' },
            { value: 'watch', label: 'Streaming' },
          ]}
        />
      </Row>
      <Row entry={findEntry('logs.poll-interval')}>
        <Segmented
          ariaLabel="Polling interval"
          disabled={logsMode !== 'poll'}
          value={String(Math.round(logsPollMs / 1000))}
          onChange={(v) => setLogsPollMs(Number(v) * 1000)}
          options={LOG_POLL_PRESETS.map((n) => ({ value: String(n / 1000), label: `${n / 1000}s` }))}
        />
      </Row>
      </SettingsGroup>
      <SettingsGroup title="Display" entries={['logs.wrap', 'logs.timestamps', 'logs.time-zone', 'logs.color-levels', 'logs.structured']}>
      <Row entry={findEntry('logs.wrap')}>
        <Checkbox aria-label="Wrap log lines by default" checked={logsWrap} onChange={(event) => setLogsWrap(event.target.checked)} />
      </Row>
      <Row entry={findEntry('logs.timestamps')}>
        <Checkbox aria-label="Show log timestamps by default" checked={logsTimestamps} onChange={(event) => setLogsTimestamps(event.target.checked)} />
      </Row>
      <Row entry={findEntry('logs.time-zone')}>
        <LogTimeZoneSelect />
      </Row>
      <Row entry={findEntry('logs.color-levels')}>
        <Checkbox aria-label="Highlight log levels by default" checked={logsColorLevels} onChange={(event) => setLogsColorLevels(event.target.checked)} />
      </Row>
      <Row entry={findEntry('logs.structured')}>
        <Checkbox aria-label="Parse log lines as JSON by default" checked={logsStructured} onChange={(event) => setLogsStructured(event.target.checked)} />
      </Row>
      </SettingsGroup>
      <SettingsGroup title="History and scrolling" entries={['logs.default-tail', 'logs.max-buffer', 'logs.stickiness']} collapsible>
      <Row entry={findEntry('logs.default-tail')}>
        <Segmented
          ariaLabel="Default log tail lines"
          value={String(logsDefaultTail)}
          onChange={(v) => setLogsDefaultTail(Number(v))}
          options={LOG_TAIL_PRESETS.map((n) => ({ value: String(n), label: `${n}` }))}
        />
      </Row>
      <Row entry={findEntry('logs.max-buffer')}>
        <Segmented
          ariaLabel="Max log buffer size"
          value={String(logsMaxBufferLines)}
          onChange={(v) => setLogsMaxBufferLines(Number(v))}
          options={LOG_BUFFER_PRESETS.map((n) => ({ value: String(n), label: `${n.toLocaleString('en-US')}` }))}
        />
      </Row>
      <Row entry={findEntry('logs.stickiness')}>
        <Segmented
          ariaLabel="Follow-scroll threshold"
          value={String(logsScrollStickiness)}
          onChange={(v) => setLogsScrollStickiness(Number(v))}
          options={[
            { value: '20', label: '20 px' },
            { value: '40', label: '40 px' },
            { value: '80', label: '80 px' },
            { value: '120', label: '120 px' },
          ]}
        />
      </Row>
      </SettingsGroup>
    </div>
  );
}

function KubernetesPage({ sectionTitle }: { sectionTitle: string }) {
  const rememberLastContext = useClusterStore((s) => s.rememberLastContext);
  const setRememberLastContext = useClusterStore((s) => s.setRememberLastContext);
  const rememberNamespaceScope = useClusterStore((s) => s.rememberNamespaceScope);
  const setRememberNamespaceScope = useClusterStore((s) => s.setRememberNamespaceScope);
  const portForwardLocalRange = useUiStore((s) => s.portForwardLocalRange);
  const setPortForwardLocalRange = useUiStore((s) => s.setPortForwardLocalRange);
  const portForwardAutoOpen = useUiStore((s) => s.portForwardAutoOpen);
  const setPortForwardAutoOpen = useUiStore((s) => s.setPortForwardAutoOpen);
  const [kubeconfigPath, setKubeconfigPath] = useState('');
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    void k8s.getKubeconfigPath().then((path) => {
      setKubeconfigPath(path);
    }).catch(() => {});
  }, []);

  const handleSavePath = async () => {
    try {
      setLoading(true);
      const contexts = await k8s.setKubeconfigPath(kubeconfigPath.trim() || null);
      useClusterStore.getState().setContexts(contexts);
      const current = useClusterStore.getState().currentContext;
      if (current) {
        useClusterStore.getState().selectContext(current);
      }
      toast.success('Kubeconfig updated', `Found ${contexts.length} context(s).`);
    } catch (err) {
      toast.error('Failed to set kubeconfig', String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    try {
      setLoading(true);
      const contexts = await k8s.setKubeconfigPath(null);
      const defaultPath = await k8s.getKubeconfigPath();
      setKubeconfigPath(defaultPath);
      useClusterStore.getState().setContexts(contexts);
      const current = useClusterStore.getState().currentContext;
      if (current) {
        useClusterStore.getState().selectContext(current);
      }
      toast.success('Kubeconfig reset to default', `Found ${contexts.length} context(s).`);
    } catch (err) {
      toast.error('Failed to reset kubeconfig', String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('kubernetes.remember-context')}>
        <Checkbox aria-label="Reopen last selected cluster" checked={rememberLastContext} onChange={event => setRememberLastContext(event.target.checked)} />
      </Row>
      <Row entry={findEntry('kubernetes.remember-scope')}>
        <Checkbox
          aria-label="Remember namespace scope per context"
          checked={rememberNamespaceScope}
          onChange={(event) => setRememberNamespaceScope(event.target.checked)}
        />
      </Row>
      <Row entry={findEntry('kubernetes.kubeconfig')} wide>
        <div className="flex flex-col gap-2 w-full max-w-lg">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Kubeconfig location"
              value={kubeconfigPath}
              onChange={(e) => setKubeconfigPath(e.target.value)}
              placeholder="~/.kube/config"
              className="flex-1"
            />
            <Button size="sm" variant="primary" loading={loading} disabled={loading} onClick={handleSavePath}>
              Apply
            </Button>
            <Button size="sm" variant="secondary" disabled={loading} onClick={handleReset} title="Reset to standard ~/.kube/config or $KUBECONFIG">
              Reset
            </Button>
          </div>
          <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
            Specify a custom kubeconfig file path, or click Reset to use the default location.
          </p>
        </div>
      </Row>
      <Row entry={findEntry('kubernetes.port-range')}>
        <Input
          aria-label="Local port forward range"
          value={portForwardLocalRange}
          onChange={(e) => setPortForwardLocalRange(e.target.value)}
          placeholder="8000-8999"
          className="w-32"
        />
      </Row>
      <Row entry={findEntry('kubernetes.auto-open-browser')}>
        <Checkbox
          aria-label="Auto-open browser on port forward"
          checked={portForwardAutoOpen}
          onChange={(event) => setPortForwardAutoOpen(event.target.checked)}
        />
      </Row>
    </div>
  );
}

function AboutPage({ sectionTitle }: { sectionTitle: string }) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const clusterVersion = useClusterStore((s) => s.clusterVersion);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('about.kubiki')} wide>
        <div className="p-3 rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-surface)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <img
                src="/brand/kubiki-logo-gray-dark.svg"
                alt="Kubiki"
                width={360}
                height={128}
                draggable={false}
                className="block h-10 w-auto max-w-full shrink-0 select-none"
              />
              <span className="text-[length:calc(13px*var(--ui-factor))] text-[var(--text-muted)]">{APP_VERSION}</span>
            </div>
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-0.5">
              Desktop Kubernetes IDE · Apache License 2.0
            </div>
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-1.5">
              Author: <a href="https://github.com/JustYarick" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">JustYarick</a>
            </div>
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mt-1.5 leading-relaxed">
              Kubiki provides a local workspace for day-to-day Kubernetes administration: resource browsing, YAML editing,
              resource topology, Helm management, logs, terminals and port forwarding. Live data comes from the Rust backend
              using the credentials of the selected kubeconfig context.
            </div>
          </div>
        </div>
      </Row>
      <Row entry={findEntry('about.updates')} wide><UpdateSettings /></Row>
      <Row entry={findEntry('about.cluster')}>
        <div className="flex items-center gap-2">
          <Input aria-label="Current context" value={currentContext ?? '—'} readOnly className="w-[calc(200px*var(--ui-factor))]" />
          <Input aria-label="Server version" value={clusterVersion ? `v${clusterVersion.replace(/^v?/, '')}` : '—'} readOnly className="w-20" />
        </div>
      </Row>
    </div>
  );
}

function AiPage({ page }: { page: AgentSettingsPage }) {
  return <AgentSettings page={page} hideNavigation />;
}

function DeveloperPage({ sectionTitle }: { sectionTitle: string }) {
  const enabled = useUiStore(state => state.developerMode);
  const setEnabled = useUiStore(state => state.setDeveloperMode);
  return <div><SectionTitle>{sectionTitle}</SectionTitle>
    <Row entry={findEntry('developer.mode')}><Checkbox aria-label="Developer mode" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></Row>
  </div>;
}

function pageContent(page: SettingsPageDef, aiPage: AgentSettingsPage): React.ReactElement {
  switch (page.id) {
    case 'topology': return <TopologyPage sectionTitle={page.sectionTitle} />;
    case 'developer': return <DeveloperPage sectionTitle={page.sectionTitle} />;
    case 'ai': return <AiPage page={aiPage} />;
    case 'appearance': return <AppearancePage sectionTitle={page.sectionTitle} />;
    case 'editor': return <EditorPage sectionTitle={page.sectionTitle} />;
    case 'terminal': return <TerminalPage sectionTitle={page.sectionTitle} />;
    case 'logs': return <LogsPage sectionTitle={page.sectionTitle} />;
    case 'kubernetes': return <KubernetesPage sectionTitle={page.sectionTitle} />;
    case 'about': return <AboutPage sectionTitle={page.sectionTitle} />;
    default: return <AppearancePage sectionTitle={findPage('appearance').sectionTitle} />;
  }
}

/* ------------------------------------------------------------------ */
/* Reset handlers (page footer action)                                 */
/* ------------------------------------------------------------------ */

const RESET_HANDLERS: Partial<Record<SettingsPageId, () => void>> = {
  topology: () => {
    useUiStore.getState().resetTopologyRendering();
    toast.success('Topology defaults restored');
  },
  appearance: () => {
    useUiStore.getState().resetAppearance();
    useUiStore.getState().resetAllTableLayouts();
    useTableViewStore.getState().resetAll();
    toast.success('Appearance and table defaults restored');
  },
  editor: () => {
    const ui = useUiStore.getState();
    ui.setEditorFontSize(DEFAULT_APPEARANCE.editorFontSize);
    ui.setYamlCleanView(true);
    ui.setYamlHideManagedFields(true);
    toast.success('Editor defaults restored');
  },
  terminal: () => {
    const ui = useUiStore.getState();
    ui.setTerminalFontSize(DEFAULT_APPEARANCE.terminalFontSize);
    ui.setTerminalFontFamily(DEFAULT_TERMINAL_FONT);
    ui.setTerminalLineHeight(1.2);
    ui.setTerminalScrollback(DEFAULT_SCROLLBACK);
    ui.setTerminalAckTimeoutSecs(0);
    toast.success('Terminal defaults restored');
  },
  logs: () => {
    const ui = useUiStore.getState();
    ui.setLogsWrap(true);
    ui.setLogsTimestamps(true);
    ui.setLogsColorLevels(false);
    ui.setLogsStructured(false);
    ui.setLogsTimestampZone('utc');
    ui.setLogsMode('poll');
    ui.setLogsPollMs(2000);
    ui.setLogsDefaultTail(500);
    ui.setLogsMaxBufferLines(1000);
    ui.setLogsScrollStickiness(40);
    toast.success('Log defaults restored');
  },
  kubernetes: () => {
    useClusterStore.getState().setRememberLastContext(true);
    useClusterStore.getState().setRememberNamespaceScope(true);
    const ui = useUiStore.getState();
    ui.setPortForwardLocalRange('8000-8999');
    ui.setPortForwardAutoOpen(false);
    toast.success('Kubernetes defaults restored');
  },
};

/* ------------------------------------------------------------------ */
/* Search field                                                        */
/* ------------------------------------------------------------------ */

function SettingsSearch({ value, onChange, onKeyDown }: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="relative flex items-center w-full">
      <Search size="calc(13px * var(--ui-factor))" className="absolute left-2 text-[var(--text-muted)] pointer-events-none" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          /* Escape first clears the query; the dialog closes on the next press. */
          if (event.key === 'Escape' && value) event.stopPropagation();
          onKeyDown?.(event);
        }}
        aria-label="Search settings"
        placeholder="Search settings"
        spellCheck={false}
        className={cx(
          'h-[calc(28px*var(--ui-factor))] w-full bg-[var(--bg-primary)] text-xs text-[var(--text-primary)] rounded-[calc(4px*var(--ui-factor))] border outline-none transition-colors pl-7 pr-7',
          'placeholder:text-[var(--text-muted)] border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)]'
        )}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded"
        >
          <X size="calc(12px * var(--ui-factor))" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export const SettingsDialog: React.FC = () => {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [query, setQuery] = useState('');
  const [aiPage, setAiPage] = useState<AgentSettingsPage>('agent');
  const [pageId, setPageId] = useState<SettingsPageId>('appearance');
  const contentRef = useRef<HTMLElement>(null);

  const aiSettings=useAiStore(s=>s.settings);
  const aiPages=availableAiSettingsPages(aiSettings);
  const aiMode=aiSettings.runtime;
  const pages = useMemo(() => filterPages(query).map(page=>page.id==='ai'?{...page,entries:page.entries.filter(entry=>availableAiSettingsPages({runtime:aiMode}).some(item=>entry.id===`ai.${item.id}`))}:page).filter(page=>page.entries.length>0 && (page.id!=='ai' || !query.trim() || page.entries.some(entry=>entryMatches(entry,query)) || /^(ai|agent|assistant)$/i.test(query.trim()))), [query,aiMode]);
  const activePage = pages.find((page) => page.id === pageId) ?? pages[0];
  const requestedAiPage = query.trim() ? aiPages.find(item => entryMatches(findEntry(`ai.${item.id}`), query))?.id ?? aiPage : aiPage;
  const selectedAiPage = aiPages.some(item=>item.id===requestedAiPage) ? requestedAiPage : 'agent';
  const resetHandler = activePage ? RESET_HANDLERS[activePage.id] : undefined;
  useEffect(() => { contentRef.current?.scrollTo({top: 0}); }, [activePage?.id, selectedAiPage]);

  const close = () => setOpen(false);

  return (
    <SearchContext.Provider value={query}>
      <Modal
        open={open}
        onClose={close}
        width={860}
        className="settings-modal"
        centered
        title="Settings"
        padded={false}
        footer={
          <>
            {resetHandler && activePage?.resetLabel && (
              <Button size="sm" onClick={resetHandler}>
                <RotateCcw size="calc(12px * var(--ui-factor))" /> {activePage.resetLabel}
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="primary" onClick={close}>Done</Button>
          </>
        }
      >
        <div className="flex flex-col h-full min-h-0 overflow-hidden">
          <div className="shrink-0 px-3 pt-3 pb-2.5">
            <SettingsSearch
              value={query}
              onChange={setQuery}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const target = firstMatchingPage(query) ?? pages[0];
                if (target) setPageId(target.id);
              }}
            />
          </div>
          <div className="settings-dialog-layout flex-1 min-h-0 flex border-t border-[var(--border-subtle)]">
            <nav
              aria-label="Settings categories"
              className="settings-categories w-[calc(216px*var(--ui-factor))] shrink-0 overflow-y-auto kubiki-scrollbar bg-[var(--bg-sidebar)] border-r border-[var(--border-default)] px-1.5 py-2 space-y-0.5"
            >
              {pages.map((page) => {
                const selected = activePage?.id === page.id;
                const Icon = page.icon;
                return (
                  <React.Fragment key={page.id}>
                  <button
                    type="button"
                    onClick={() => setPageId(page.id)}
                    aria-current={selected && page.id !== 'ai' ? 'page' : undefined}
                    aria-expanded={page.id === 'ai' ? selected : undefined}
                    className={cx(
                      'w-full flex items-center gap-2 px-2.5 h-[calc(27px*var(--ui-factor))] rounded-[calc(4px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] text-left transition-colors',
                      selected && page.id !== 'ai'
                        ? 'bg-[var(--bg-selection)] text-white'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    <Icon aria-hidden="true" size="calc(14px * var(--ui-factor))" strokeWidth={1.75} className={selected ? 'text-white' : 'text-[var(--text-muted)]'} />
                    <span className="truncate"><Highlight text={page.title} query={query} /></span>
                  </button>
                  {page.id === 'ai' && selected && <div className="pl-5 py-1 space-y-0.5" aria-label="AI settings subsections">
                    {aiPages.map(item => <button key={item.id} type="button" aria-current={selectedAiPage === item.id ? 'page' : undefined} className={cx('block w-full rounded px-2 py-1 text-left text-xs', selectedAiPage === item.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} onClick={() => { setQuery(''); setAiPage(item.id); }}>{item.label}</button>)}
                  </div>}
                  </React.Fragment>
                );
              })}
              {pages.length === 0 && (
                <p className="px-2.5 py-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">No categories</p>
              )}
            </nav>
            <div className="settings-mobile-navigation">
              <label>Category<Select className="ide-select" aria-label="Settings category" value={activePage?.id ?? ''} onChange={e => setPageId(e.target.value as SettingsPageId)}>{pages.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</Select></label>
              {activePage?.id === 'ai' && <label>Section<Select className="ide-select" aria-label="AI settings section" value={selectedAiPage} onChange={e => { setQuery(''); setAiPage(e.target.value as AgentSettingsPage); }}>{aiPages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></label>}
            </div>
            <section
              ref={contentRef}
              aria-label={activePage ? `Settings: ${activePage.title}` : 'Search results'}
              className="settings-content flex-1 min-w-0 overflow-y-auto kubiki-scrollbar px-4 pb-4"
            >
              {activePage ? (
                pageContent(activePage, selectedAiPage)
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-6">
                  <Search size="calc(22px * var(--ui-factor))" className="text-[var(--text-muted)] mb-1" />
                  <p className="text-sm text-[var(--text-primary)]">No settings found</p>
                  <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                    No results for "{query.trim()}". Try "font" or "scale".
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </Modal>
    </SearchContext.Provider>
  );
};
