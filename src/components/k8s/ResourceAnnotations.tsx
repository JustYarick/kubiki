import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ANNOTATION_LABELS, LAST_APPLIED_ANNOTATION, annotationFields, lastAppliedSummary, parseAnnotationValue, type AnnotationField } from '../../core/resources/annotations';
import { IconButton } from '../ui/Button';
import { toast } from '../../state/notifications_store';

export function ResourceAnnotations({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).sort(([a], [b]) => {
    if (a === LAST_APPLIED_ANNOTATION) return 1;
    if (b === LAST_APPLIED_ANNOTATION) return -1;
    return Number(Boolean(ANNOTATION_LABELS[b])) - Number(Boolean(ANNOTATION_LABELS[a])) || a.localeCompare(b);
  });
  return (
    <div className="divide-y divide-[var(--border-default)]">
      {entries.map(([key, value]) => <AnnotationEntry key={key} name={key} value={value} />)}
    </div>
  );
}

function AnnotationEntry({ name, value }: { name: string; value: unknown }) {
  const { source, structured } = parseAnnotationValue(value);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [copiedSource, setCopiedSource] = useState<string | null>(null);
  const lastApplied = name === LAST_APPLIED_ANNOTATION && structured && !Array.isArray(structured);
  const summary = lastApplied ? lastAppliedSummary(structured) : [];
  const { fields, truncated } = structured ? annotationFields(structured) : { fields: [], truncated: false };
  const longText = source.length > 500 || source.split('\n').length > 6;
  return (
    <article aria-label={name} data-annotation-key={name} className="py-3 first:pt-0 last:pb-0 min-w-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {ANNOTATION_LABELS[name] && <div className="text-[length:calc(11px*var(--ui-factor))] font-medium mb-1">{ANNOTATION_LABELS[name]}</div>}
          <div className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-secondary)] break-all">{name}</div>
        </div>
        <IconButton icon={copiedSource === source ? Check : Copy} size="sm" aria-label={`Copy annotation ${name}`} tooltip="Copy original value" onClick={() => {
          void navigator.clipboard.writeText(source).then(() => setCopiedSource(source)).catch(() => toast.error('Clipboard unavailable'));
        }} />
      </div>
      {!!summary.length && <div className="mt-2"><FieldRows fields={summary} /></div>}
      {structured ? (
        <details className="mt-2" open={lastApplied || fields.length > 8 ? undefined : true}>
          <summary className="text-[length:calc(11px*var(--ui-factor))] text-[var(--accent)] cursor-pointer select-none">
            {lastApplied ? 'Manifest fields' : 'Structured value'} · {fields.length}{truncated ? '+' : ''} fields
          </summary>
          <div className="mt-2 max-h-72 overflow-auto kubiki-scrollbar"><FieldRows fields={fields} /></div>
          {truncated && <p className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-2">Preview limited. The source contains the complete value.</p>}
        </details>
      ) : !longText ? <div className="mt-1.5 text-[length:calc(11px*var(--ui-factor))] font-mono whitespace-pre-wrap break-words">{source || <span className="text-[var(--text-muted)]">Empty value</span>}</div>
        : <p className="mt-1.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)]">{source.length.toLocaleString()} characters · {source.split('\n').length} lines</p>}
      {(structured || longText) && <details className="mt-2" onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
        <summary className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer select-none">Original value</summary>
        {sourceOpen && <pre className="mt-2 max-h-60 overflow-auto kubiki-scrollbar bg-[var(--bg-secondary)] rounded border border-[var(--border-default)] p-2 text-[length:calc(10px*var(--ui-factor))] font-mono whitespace-pre-wrap break-all">{source}</pre>}
      </details>}
    </article>
  );
}

function FieldRows({ fields }: { fields: AnnotationField[] }) {
  return (
    <dl className="grid grid-cols-[minmax(calc(80px*var(--ui-factor)),0.9fr)_minmax(0,1.3fr)] gap-x-3 text-[length:calc(11px*var(--ui-factor))]">
      {fields.map(({ path, value }) => <div key={path} className="col-span-2 grid grid-cols-subgrid border-b border-[var(--border-subtle)] py-1.5 last:border-0">
        <dt className="text-[var(--text-secondary)] break-words font-mono text-[length:calc(10px*var(--ui-factor))]">{path}</dt>
        <dd className="min-w-0 font-mono whitespace-pre-wrap break-words">{value}</dd>
      </div>)}
    </dl>
  );
}
