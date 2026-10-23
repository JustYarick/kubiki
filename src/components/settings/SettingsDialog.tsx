import React, { createContext, useContext, useMemo, useState } from 'react';
import { RotateCcw, Search, X } from 'lucide-react';
import packageJson from '../../../package.json';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Checkbox } from '../ui/Checkbox';
import { TerminalFontSettings } from '../TerminalFontSettings';
import { toast } from '../../state/notifications_store';
import { useClusterStore } from '../../state/cluster_store';
import { DEFAULT_SCROLLBACK, TERMINAL_SCROLLBACK_PRESETS, useUiStore } from '../../state/ui_store';
import { DEFAULT_TERMINAL_FONT } from '../../core/terminal_appearance';
import { APPEARANCE_LIMITS, DEFAULT_APPEARANCE } from '../../core/appearance';
import { cx } from '../../core/utils/cx';
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
  return (
    <div className="text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)] pt-1.5 pb-0.5">
      {children}
    </div>
  );
}

interface RowProps {
  entry: SettingsEntry;
  children: React.ReactNode;
  /** Full-width blocks (previews, embedded panels) render label above control. */
  wide?: boolean;
  below?: React.ReactNode;
}

function Row({ entry, wide, below, children }: RowProps) {
  const query = useContext(SearchContext);
  if (query.trim() && !entryMatches(entry, query)) return null;
  const heading = (
    <div className="min-w-0">
      <div className="text-[length:calc(12px*var(--ui-factor))] text-[var(--text-primary)]">
        <Highlight text={entry.label} query={query} />
      </div>
      {entry.description && (
        <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mt-0.5 leading-snug">
          <Highlight text={entry.description} query={query} />
        </div>
      )}
    </div>
  );
  if (wide) {
    return (
      <div id={`settings-row-${entry.id}`} className="py-2.5 min-w-0 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[var(--border-subtle)]">
        {heading}
        <div className="mt-2">{children}</div>
      </div>
    );
  }
  return (
    <div id={`settings-row-${entry.id}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5 min-w-0 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[var(--border-subtle)]">
      {heading}
      <div className="shrink-0">{children}</div>
      {below && <div className="w-full">{below}</div>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center rounded-[calc(5px*var(--ui-factor))] border border-[var(--border-default)] overflow-hidden">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-[calc(26px*var(--ui-factor))] px-2.5 text-[length:calc(11px*var(--ui-factor))] transition-colors capitalize',
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
    </div>
  );
}

function EditorPage({ sectionTitle }: { sectionTitle: string }) {
  const editorFontSize = useUiStore((s) => s.editorFontSize);
  const setEditorFontSize = useUiStore((s) => s.setEditorFontSize);
  const yamlCleanView = useUiStore((s) => s.yamlCleanView);
  const setYamlCleanView = useUiStore((s) => s.setYamlCleanView);
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
    </div>
  );
}

function TerminalPage({ sectionTitle }: { sectionTitle: string }) {
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useUiStore((s) => s.setTerminalFontSize);
  const terminalScrollback = useUiStore((s) => s.terminalScrollback);
  const setTerminalScrollback = useUiStore((s) => s.setTerminalScrollback);
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
        <select
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
        </select>
      </Row>
    </div>
  );
}

function LogsPage({ sectionTitle }: { sectionTitle: string }) {
  const logsWrap = useUiStore((s) => s.logsWrap);
  const setLogsWrap = useUiStore((s) => s.setLogsWrap);
  const logsTimestamps = useUiStore((s) => s.logsTimestamps);
  const setLogsTimestamps = useUiStore((s) => s.setLogsTimestamps);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('logs.wrap')}>
        <Checkbox aria-label="Wrap log lines by default" checked={logsWrap} onChange={(event) => setLogsWrap(event.target.checked)} />
      </Row>
      <Row entry={findEntry('logs.timestamps')}>
        <Checkbox aria-label="Show log timestamps by default" checked={logsTimestamps} onChange={(event) => setLogsTimestamps(event.target.checked)} />
      </Row>
    </div>
  );
}

function KubernetesPage({ sectionTitle }: { sectionTitle: string }) {
  const rememberNamespaceScope = useClusterStore((s) => s.rememberNamespaceScope);
  const setRememberNamespaceScope = useClusterStore((s) => s.setRememberNamespaceScope);
  return (
    <div>
      <SectionTitle>{sectionTitle}</SectionTitle>
      <Row entry={findEntry('kubernetes.remember-scope')}>
        <Checkbox
          aria-label="Remember namespace scope per context"
          checked={rememberNamespaceScope}
          onChange={(event) => setRememberNamespaceScope(event.target.checked)}
        />
      </Row>
      <Row entry={findEntry('kubernetes.kubeconfig')}>
        <Input aria-label="Kubeconfig location" value="~/.kube/config or $KUBECONFIG" readOnly className="w-[calc(200px*var(--ui-factor))]" />
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
        <div className="flex items-start gap-3 p-3 rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-surface)]">
          <div className="w-9 h-9 rounded-[calc(6px*var(--ui-factor))] bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white text-lg font-bold shadow-xs shrink-0">
            ⎈
          </div>
          <div className="min-w-0">
            <div className="text-[length:calc(13px*var(--ui-factor))] font-semibold text-[var(--text-primary)]">
              Kubiki <span className="text-[var(--text-muted)] font-normal">{APP_VERSION}</span>
            </div>
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-0.5">
              Desktop Kubernetes IDE · Apache License 2.0
            </div>
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mt-1.5 leading-relaxed">
              Kubiki provides a local workspace for day-to-day Kubernetes administration: resource browsing, YAML editing,
              resource topology, Helm management, logs, terminals and port forwarding. Live data comes from the Rust backend
              using the credentials of the selected kubeconfig context.
            </div>
          </div>
        </div>
      </Row>
      <Row entry={findEntry('about.cluster')}>
        <div className="flex items-center gap-2">
          <Input aria-label="Current context" value={currentContext ?? '—'} readOnly className="w-[calc(200px*var(--ui-factor))]" />
          <Input aria-label="Server version" value={clusterVersion ? `v${clusterVersion.replace(/^v?/, '')}` : '—'} readOnly className="w-20" />
        </div>
      </Row>
    </div>
  );
}

function pageContent(page: SettingsPageDef): React.ReactElement {
  switch (page.id) {
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
  appearance: () => {
    useUiStore.getState().resetAppearance();
    toast.success('Appearance defaults restored');
  },
  editor: () => {
    const ui = useUiStore.getState();
    ui.setEditorFontSize(DEFAULT_APPEARANCE.editorFontSize);
    ui.setYamlCleanView(true);
    toast.success('Editor defaults restored');
  },
  terminal: () => {
    const ui = useUiStore.getState();
    ui.setTerminalFontSize(DEFAULT_APPEARANCE.terminalFontSize);
    ui.setTerminalFontFamily(DEFAULT_TERMINAL_FONT);
    ui.setTerminalLineHeight(1.2);
    ui.setTerminalScrollback(DEFAULT_SCROLLBACK);
    toast.success('Terminal defaults restored');
  },
  logs: () => {
    const ui = useUiStore.getState();
    ui.setLogsWrap(true);
    ui.setLogsTimestamps(true);
    toast.success('Log defaults restored');
  },
  kubernetes: () => {
    useClusterStore.getState().setRememberNamespaceScope(true);
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
  const [pageId, setPageId] = useState<SettingsPageId>('appearance');

  const pages = useMemo(() => filterPages(query), [query]);
  const activePage = pages.find((page) => page.id === pageId) ?? pages[0];
  const resetHandler = activePage ? RESET_HANDLERS[activePage.id] : undefined;

  const close = () => setOpen(false);

  return (
    <SearchContext.Provider value={query}>
      <Modal
        open={open}
        onClose={close}
        width={860}
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
          <div className="flex-1 min-h-0 flex border-t border-[var(--border-subtle)]">
            <nav
              aria-label="Settings categories"
              className="w-[calc(216px*var(--ui-factor))] shrink-0 overflow-y-auto kubiki-scrollbar bg-[var(--bg-sidebar)] border-r border-[var(--border-default)] px-1.5 py-2 space-y-0.5"
            >
              {pages.map((page) => {
                const selected = activePage?.id === page.id;
                const Icon = page.icon;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setPageId(page.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cx(
                      'w-full flex items-center gap-2 px-2.5 h-[calc(27px*var(--ui-factor))] rounded-[calc(4px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] text-left transition-colors',
                      selected
                        ? 'bg-[var(--bg-selection)] text-white'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    <Icon size="calc(14px * var(--ui-factor))" strokeWidth={1.75} className={selected ? 'text-white' : 'text-[var(--text-muted)]'} />
                    <span className="truncate"><Highlight text={page.title} query={query} /></span>
                  </button>
                );
              })}
              {pages.length === 0 && (
                <p className="px-2.5 py-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">No categories</p>
              )}
            </nav>
            <section
              aria-label={activePage ? `Settings: ${activePage.title}` : 'Search results'}
              className="flex-1 min-w-0 overflow-y-auto kubiki-scrollbar px-4 pb-4"
            >
              {activePage ? (
                pageContent(activePage)
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-6">
                  <Search size="calc(22px * var(--ui-factor))" className="text-[var(--text-muted)] mb-1" />
                  <p className="text-sm text-[var(--text-primary)]">No settings found</p>
                  <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                    Nothing matches “{query.trim()}”. Try shorter or different keywords, for example “font” or “scale”.
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
