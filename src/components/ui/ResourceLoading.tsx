import './resource-loading.css';

/** Shared loading surface: stable geometry, one animation, and readable reduced-motion feedback. */
export function ResourceLoading({ label = 'Loading resources…', description = 'Waiting for Kubernetes to respond.', compact = false }: { label?: string; description?: string; compact?: boolean }) {
  return <div role="status" aria-live="polite" className={`resource-loading${compact ? ' resource-loading-compact' : ''}`} data-testid="resource-loading">
    <div className="resource-loading-progress" aria-hidden="true"><span /></div>
    <div className="resource-loading-copy"><span>{label}</span>{!compact && <p>{description}</p>}</div>
    {!compact && <div className="resource-loading-skeleton" aria-hidden="true">{[0, 1, 2, 3, 4].map(row => <div key={row}><span /><span /><span /></div>)}</div>}
  </div>;
}
