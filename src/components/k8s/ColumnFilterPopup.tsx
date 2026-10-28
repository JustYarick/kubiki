import { selectedFirst } from '../../core/utils/selected_first';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { columnFilterCount, type ColumnFilter } from '../../core/resources/column_filters';
import { uiPixels } from '../../core/appearance';

export interface ColumnFilterProps {
  /** Viewport position of the popup. */
  rect: { x: number; y: number };
  columnLabel: string;
  /** Distinct values of the column with their occurrence counts. */
  values: Map<string, number>;
  /** Included and excluded values; empty lists mean no filter. */
  selected: ColumnFilter;
  /** One-click values offered above the list, e.g. the common statuses. */
  quick?: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const PANEL_WIDTH = 280;
const LIST_HEIGHT = 288;

/**
 * Column filter popup.
 *
 * Opens on right-click of a column header. It stays compact: a search field,
 * a scrollable list of values with counts and a footer. Values of one column
 * are combined with OR, several column filters with AND.
 */
export function ColumnFilterPopup({ rect, columnLabel, values, selected, quick, onToggle, onClear, onClose }: ColumnFilterProps) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: rect.y, left: rect.x });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected.include), [selected.include]);

  const excludedSet = useMemo(() => new Set(selected.exclude), [selected.exclude]);
  const activeCount = columnFilterCount(selected);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.type === 'checkbox' && panelRef.current?.contains(focused)) focused.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = new Map(values);
    for (const value of [...selected.include, ...selected.exclude]) if (!available.has(value)) available.set(value, 0);
    return selectedFirst([...available.entries()]
      .filter(([value]) => !q || value.toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), ([value]) => selected.include.includes(value) || selected.exclude.includes(value));
  }, [values, query, selected]);

  useEffect(() => {
    const panel = panelRef.current;
    const height = panel?.offsetHeight ?? 360;
    const width = panel?.offsetWidth ?? PANEL_WIDTH;
    setPosition({
      top: Math.max(8, Math.min(rect.y, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.x, window.innerWidth - width - 8)),
    });
    searchRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (panel?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [rect.x, rect.y, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Filter by ${columnLabel}`}
      data-testid="column-filter-popup"
      style={{ top: position.top, left: position.left, width: uiPixels(PANEL_WIDTH) }}
      className="fixed z-[88] rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] flex flex-col overflow-hidden kub-pop"
    >
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5 shrink-0">
        <Filter size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0 truncate text-[length:calc(11px*var(--ui-factor))] font-semibold text-[var(--text-primary)]" title={columnLabel}>
          {columnLabel}
        </span>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${columnLabel} filter`}
            className="shrink-0 rounded px-1 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filter"
          className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          <X size="calc(12px * var(--ui-factor))" />
        </button>
      </div>

      <div className="px-2 pb-1.5 shrink-0">
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${columnLabel.toLowerCase()} values…`}
          aria-label={`Search ${columnLabel} values`}
          className="w-full h-[calc(24px*var(--ui-factor))] bg-[var(--bg-canvas)] text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] rounded-[calc(4px*var(--ui-factor))] border border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)] outline-none transition-colors placeholder:text-[var(--text-muted)] px-2"
        />
      </div>

      {quick && quick.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5 shrink-0">
          {selectedFirst([...new Set([...quick, ...selected.include, ...selected.exclude])], value => selectedSet.has(value) || excludedSet.has(value)).slice(0, 6).map((value) => {
            const active = selectedSet.has(value);
            const excluded = excludedSet.has(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active || excluded}
                title={`${value}: ${excluded ? 'excluded' : active ? 'included' : 'any'}. Click to ${excluded ? 'reset' : active ? 'exclude' : 'include'}.`}
                onClick={() => onToggle(value)}
                className={cx(
                  'rounded-[calc(4px*var(--ui-factor))] px-1.5 h-[calc(20px*var(--ui-factor))] text-[length:calc(10.5px*var(--ui-factor))] border transition-colors',
                  excluded ? 'border-[var(--status-danger)] text-[var(--status-danger)]' : active
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                )}
              >
                {excluded ? `− ${value}` : value}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto kubiki-scrollbar px-1 pb-1" style={{ maxHeight: uiPixels(LIST_HEIGHT) }}>
        {entries.length === 0 ? (
          <p className="px-2 py-3 text-center text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
            {query ? 'No matching values' : 'No values to filter'}
          </p>
        ) : (
          entries.map(([value, count]) => {
            const checked = selectedSet.has(value);
            const excluded = excludedSet.has(value);
            return (
              <label
                key={value}
                className={cx(
                  'flex items-center gap-2 px-1.5 h-[calc(24px*var(--ui-factor))] rounded-[calc(3px*var(--ui-factor))] cursor-pointer text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                  checked && 'bg-[var(--accent-subtle)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  ref={element => { if (element) element.indeterminate = excluded; }}
                  aria-checked={excluded ? 'mixed' : checked}
                  aria-describedby="column-filter-cycle-hint"
                  onChange={() => onToggle(value)}
                  aria-label={value}
                  className="shrink-0 w-[calc(13px*var(--ui-factor))] h-[calc(13px*var(--ui-factor))] accent-[var(--accent)] cursor-pointer"
                />
                <span className="flex-1 min-w-0 truncate" title={value}>{value}</span>
                <span className="shrink-0 text-[var(--status-danger)]">{excluded ? 'Excluded' : ''}</span>
                <span className="shrink-0 font-mono text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] tabular-nums">{count}</span>
              </label>
            );
          })
        )}
      </div>

      <div className="px-2 py-1.5 border-t border-[var(--border-subtle)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] shrink-0">
        {activeCount > 0 ? `${selected.include.length} included · ${selected.exclude.length} excluded` : `${entries.length} values · click to filter`}
        <div id="column-filter-cycle-hint">Click: include → exclude → reset</div>
      </div>
    </div>,
    document.body,
  );
}
