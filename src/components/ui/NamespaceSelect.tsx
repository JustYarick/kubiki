import { useId, useState } from 'react';
import { Check, ChevronDown, Layers, Search } from 'lucide-react';
import { namespaceNames, namespaceScope, namespaceScopeLabel } from '../../core/resources/namespace_scope';
import { isValidNamespaceName } from '../../core/resources/resource_types';
import { Popover } from './Dropdown';
import { Button } from './Button';
import { cx } from '../../core/utils/cx';

/** Selection is applied once, so a batch of checkboxes starts one new data generation. */
export function NamespaceSelect({ label = 'Namespace Scope', value, options, onChange, className, allowCustom = false }: {
  label?: string; value: string; options: string[]; onChange: (scope: string) => void; className?: string; allowCustom?: boolean;
}) {
  const names = namespaceNames(value);
  return <Popover width={320} trigger={({ open }) => <button type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} data-value={value}
    title={namespaceScopeLabel(value)} className={cx('flex items-center gap-1.5 h-[calc(26px*var(--ui-factor))] px-2 rounded border border-[var(--border-default)] text-xs min-w-0 max-w-[calc(260px*var(--ui-factor))] hover:bg-[var(--bg-hover)]', className)}>
    <Layers size="calc(12px * var(--ui-factor))" className="text-violet-400 shrink-0" /><span className="truncate">{names && names.length > 1 ? `${names.length} namespaces` : namespaceScopeLabel(value)}</span><ChevronDown size="calc(11px * var(--ui-factor))" className="shrink-0 ml-auto" />
  </button>}>
    {close => <NamespaceMenu key={value} label={label} value={value} options={options} allowCustom={allowCustom} onApply={scope => { onChange(scope); close(); }} />}
  </Popover>;
}
function NamespaceMenu({ label, value, options, allowCustom, onApply }: { label: string; value: string; options: string[]; allowCustom: boolean; onApply: (scope: string) => void }) {
  const [selected, setSelected] = useState<string[] | null>(() => namespaceNames(value));
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const id = useId();
  const candidates = [...new Set([...options, ...(selected ?? []), ...(allowCustom && isValidNamespaceName(query.trim()) && query.trim() !== 'all' ? [query.trim()] : [])])].sort();
  const showAll = !query.trim() || 'all namespaces'.includes(query.trim().toLowerCase());
  const visibleLimit = limit - Number(showAll);
  const filtered = candidates.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (name: string) => setSelected(previous => previous?.includes(name) ? previous.filter(value => value !== name) : [...(previous ?? []), name]);
  return <div role="dialog" aria-label={`Choose ${label}`} className="text-xs">
    <div className="px-2 pb-2 pt-1">
      <div className="relative"><Search size="calc(13px * var(--ui-factor))" className="absolute left-2 top-2 text-[var(--text-muted)]" />
        <input autoFocus type="search" aria-label={`Filter ${label} by name`} aria-controls={id} placeholder="Filter by name…" value={query}
          onChange={event => { setQuery(event.target.value); setLimit(50); }} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); document.getElementById(id)?.querySelector<HTMLButtonElement>('[role="option"]')?.focus(); }
            if (event.key === 'Enter' && filtered.length === 1) { event.preventDefault(); toggle(filtered[0]); }
          }} className="h-7 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] pl-7 pr-2 text-xs outline-none focus:border-[var(--accent)]" />
      </div>
      <p className="mt-1 text-[var(--text-secondary)] text-[length:calc(10px*var(--ui-factor))]">{filtered.length} matching · {selected === null ? 'All namespaces selected' : `${selected.length} selected`}</p>
    </div>
    <div id={id} role="listbox" aria-label={label} aria-multiselectable="true" className="max-h-[calc(240px*var(--ui-factor))] overflow-y-auto kubiki-scrollbar" onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? buttons[(index + 1) % buttons.length] : event.key === 'ArrowUp' ? buttons[(index + buttons.length - 1) % buttons.length] : undefined;
      if (next) { event.preventDefault(); next.focus(); }
    }}>
      {showAll && <button type="button" role="option" aria-selected={selected === null} onClick={() => setSelected(null)} className="flex items-center gap-2 w-full h-7 px-2.5 text-left hover:bg-[var(--bg-hover)]"><span className="flex-1">All Namespaces</span>{selected === null && <Check size={13} className="text-[var(--accent)]" />}</button>}
      {filtered.slice(0, visibleLimit).map(name => <button type="button" role="option" aria-selected={selected?.includes(name) ?? false} key={name} onClick={() => toggle(name)} className="flex items-center gap-2 w-full h-7 px-2.5 text-left hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]">
        <span className={cx('w-3 h-3 rounded-sm border shrink-0 flex items-center justify-center', selected?.includes(name) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-strong)]')}>{selected?.includes(name) && <Check size={11} />}</span><span className="truncate" title={name}>{name}</span>
      </button>)}
    </div>
    {filtered.length > visibleLimit && <button type="button" className="w-full py-2 text-[var(--accent)]" onClick={() => setLimit(value => value + 50)}>Show next 50</button>}
    {!filtered.length && <p className="px-2.5 py-2 text-[var(--text-muted)]">No matching namespaces.</p>}
    <div className="flex justify-between gap-2 border-t border-[var(--border-subtle)] px-2 pt-2 mt-1"><Button size="sm" onClick={() => setSelected([])}>Clear selection</Button><Button size="sm" variant="primary" disabled={selected?.length === 0} onClick={() => onApply(namespaceScope(selected))}>Apply namespaces</Button></div>
  </div>;
}
