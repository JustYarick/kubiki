import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Braces, Clock, Download, Eraser, MoreHorizontal, Palette, Pause, Play, WrapText } from 'lucide-react';
import { useUiStore } from '../../state/ui_store';
import { uiFactor } from '../../core/appearance';
import { ContainerSelect } from './ContainerSelect';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Popover } from '../ui/Dropdown';
import type { ResourceContainer } from '../../types/k8s';

export function LogsToolbar({ name, namespace, context, containers, container, onContainer, filter, onFilter, isRegex, onToggleRegex, paused, onPause, timestamps, onTimestamps, wrap, onWrap, structured, onStructured, colorLevels, onColorLevels, onDownload, onClear, sourceControls }: {
  sourceControls?: ReactNode;
  name?: string; namespace?: string; context?: string | null; containers: ResourceContainer[]; container: string; onContainer: (name: string) => void;
  filter: string; onFilter: (value: string) => void; isRegex?: boolean; onToggleRegex?: (v: boolean) => void; paused: boolean; onPause: () => void; timestamps: boolean; onTimestamps: () => void; wrap: boolean; onWrap: () => void; structured: boolean; onStructured: () => void; colorLevels?: boolean; onColorLevels?: () => void; onDownload: () => void; onClear: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null); const [compact, setCompact] = useState(true); const scale = useUiStore((s) => s.uiScale);
  useEffect(() => { const el = ref.current; if (!el) return; const resize = () => setCompact(el.clientWidth / uiFactor(scale) < 680); resize(); const observer = new ResizeObserver(resize); observer.observe(el); return () => observer.disconnect(); }, [scale]);
  const actions = [
    { icon: Clock, label: 'Timestamps', active: timestamps, run: onTimestamps },
    { icon: WrapText, label: 'Wrap', active: wrap, run: onWrap },
    { icon: Download, label: 'Download logs', run: onDownload },
    { icon: Eraser, label: 'Clear', run: onClear }
  ];
  const buttons = <div className="flex shrink-0 items-center gap-1">
    <IconButton icon={paused ? Play : Pause} size="sm" active={paused} onClick={onPause} tooltip={paused ? 'Resume log updates' : 'Pause log updates'} aria-label="Pause" />
    <IconButton icon={Palette} size="sm" active={colorLevels} onClick={onColorLevels ?? (() => {})} tooltip={colorLevels ? 'Highlight levels (On)' : 'Highlight levels (Off)'} aria-label="Highlight levels" />
    <IconButton icon={Braces} size="sm" active={structured} onClick={onStructured} tooltip={structured ? 'Structured JSON (On)' : 'Structured JSON (Off)'} aria-label="Structured JSON" />
    {(compact || sourceControls) && <Popover align="end" width={210} trigger={({ open }) => <IconButton icon={MoreHorizontal} size="sm" active={open} aria-label="Log options" tooltip="Log options" />}>
      {(close) => <div role="menu" aria-label="Log options">{compact && actions.map(({ icon: Icon, label, active, run }) => <button key={label} type="button" role={active === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={active} onClick={() => { run(); if (active === undefined) close(); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:bg-[var(--bg-hover)]"><Icon size="calc(13px * var(--ui-factor))" /><span className="flex-1">{label}</span>{active !== undefined && <span>{active ? 'On' : 'Off'}</span>}</button>)}{sourceControls}</div>}
    </Popover>}
    {!compact && actions.map(({ icon, label, active, run }) => <IconButton key={label} icon={icon} size="sm" active={active} onClick={run} tooltip={label} aria-label={label} />)}
  </div>;
  return <div ref={ref} data-testid="logs-toolbar" className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] min-w-0">
    <div className={`flex items-center gap-2 min-w-0 ${compact ? 'w-full' : 'flex-[1_1_160px]'}`}>
      <ArrowDownToLine size="calc(13px * var(--ui-factor))" className="text-blue-400 shrink-0" /><span className="text-[length:calc(10px*var(--ui-factor))] text-blue-400">Pod</span>
      <span className="flex-1 min-w-0 truncate text-xs font-mono" title={`${context} / ${namespace} / ${name}`}>{name}<span className="ml-2 text-[var(--text-muted)]">{namespace}</span></span>
      {compact && buttons}
    </div>
    <div className={`flex items-center gap-2 min-w-0 ${compact ? 'w-full' : 'flex-[2_1_300px]'}`}>
      <div className="min-w-0 max-w-[45%] shrink"><ContainerSelect containers={containers} value={container} onChange={onContainer} /></div>
      <SearchInput value={filter} onChange={onFilter} isRegex={isRegex} onToggleRegex={onToggleRegex} placeholder="Filter log lines…" className="flex-1 min-w-0 w-full" />
    </div>
    {!compact && buttons}
  </div>;
}
