import { useId, useState } from 'react';
import { Check, ChevronDown, Search, type LucideIcon } from 'lucide-react';
import { Popover } from './Dropdown';
import { cx } from '../../core/utils/cx';

export interface SelectOption { value: string; label: string }

/** A searchable, bounded menu: opening a selector never mounts thousands of options. */
export function SearchableSelect({ label, value, options, onChange, icon: Icon, className, customOption, customHint }: {
  label: string; value: string; options: SelectOption[]; onChange: (value: string) => void;
  icon?: LucideIcon; className?: string; customOption?: (query: string) => SelectOption | undefined; customHint?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return <Popover width={320} trigger={({ open }) => <button type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
    data-value={value} title={selected?.label} className={cx('flex items-center gap-1.5 h-[calc(26px*var(--ui-factor))] px-2 rounded border border-[var(--border-default)] text-xs min-w-0 max-w-[calc(260px*var(--ui-factor))] hover:bg-[var(--bg-hover)]', className)}>
    {Icon && <Icon size="calc(12px * var(--ui-factor))" className="text-violet-400 shrink-0" />}<span className="truncate">{selected?.label ?? value}</span><ChevronDown size="calc(11px * var(--ui-factor))" className="shrink-0 ml-auto" />
  </button>}>
    {(close) => <SelectMenu label={label} value={value} options={options} customOption={customOption} customHint={customHint} onSelect={(value) => { onChange(value); close(); }} />}
  </Popover>;
}

function SelectMenu({ label, value, options, onSelect, customOption, customHint }: { label: string; value: string; options: SelectOption[]; onSelect: (value: string) => void; customOption?: (query: string) => SelectOption | undefined; customHint?: string }) {
  const [query, setQuery] = useState('');
  const listId = useId();
  const extra = customOption?.(query.trim());
  const candidates = extra && !options.some((option) => option.value === extra.value) ? [...options, extra] : options;
  const filtered = candidates.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <div role="dialog" aria-label={`Choose ${label}`}>
    <div className="px-2 pb-2 pt-1">
      <div className="relative"><Search size="calc(13px * var(--ui-factor))" className="absolute left-2 top-2 text-[var(--text-muted)]" />
        <input autoFocus type="search" aria-label={`Filter ${label} by name`} placeholder="Filter by name…" value={query} aria-controls={listId}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); document.getElementById(listId)?.querySelector<HTMLButtonElement>('[role="option"]')?.focus(); }
            if (event.key === 'Enter' && filtered.length) { event.preventDefault(); onSelect(filtered[0].value); }
          }}
          className="h-7 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] pl-7 pr-2 text-xs outline-none focus:border-[var(--accent)]" />
      </div>
      <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-1">{filtered.length} matching</div>
      {customHint && <p className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-1">{customHint}</p>}
    </div>
    <div id={listId} role="listbox" aria-label={label} className="max-h-[calc(240px*var(--ui-factor))] overflow-y-auto kubiki-scrollbar">
      {filtered.map((option) => <button type="button" role="option" aria-selected={option.value === value} key={option.value}
        onClick={() => onSelect(option.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const sibling = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
            if (sibling instanceof HTMLButtonElement) sibling.focus();
          }
        }}
        className="flex items-center gap-2 w-full h-7 px-2.5 text-left text-xs hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] outline-none">
        <span className="truncate flex-1" title={option.label}>{option.label}</span>{option.value === value && <Check size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />}
      </button>)}
    </div>
    {!filtered.length && <p className="px-2.5 py-2 text-xs text-[var(--text-muted)]">No matching namespaces or scopes.</p>}
  </div>;
}
