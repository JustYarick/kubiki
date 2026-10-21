import { useState } from 'react';
import { stringify } from 'yaml';
import { DetailsSection } from '../DetailsSection';
import { Button } from '../../../ui/Button';

function NestedEntry({ label, value }: { label: string; value: object }) {
  const [open, setOpen] = useState(false);
  return <details className="details-structured-entry" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open && <pre>{stringify(value)}</pre>}</details>;
}

/** Bounded rendering for arbitrary nested API fields; large inventories expand incrementally. */
export function StructuredFields({ title, value }: { title: string; value: unknown }) {
  const [limit, setLimit] = useState(30);
  if (value == null || typeof value === 'object' && !Object.keys(value).length) return null;
  const entries = Array.isArray(value) ? value.map((entry, index) => [String(index + 1), entry] as const)
    : typeof value === 'object' ? Object.entries(value) : [['Value', value] as const];
  return <DetailsSection title={title}>
    <div className="details-structured-fields">{entries.slice(0, limit).map(([key, entry]) => typeof entry === 'object' && entry !== null
      ? <NestedEntry key={key} label={Array.isArray(value) ? `${key}. ${entry.name ?? entry.type ?? entry.kind ?? 'Entry'}` : key} value={entry} />
      : <dl key={key} className="details-properties"><dt>{key}</dt><dd>{entry == null ? '—' : String(entry)}</dd></dl>)}</div>
    {entries.length > limit && <Button size="sm" className="mt-2" onClick={() => setLimit(value => value + 30)}>Show next 30 ({entries.length - limit} remaining)</Button>}
  </DetailsSection>;
}
