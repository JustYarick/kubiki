import { useId } from 'react';
import { OverviewSection } from './OverviewSection';

const colors: Record<string, string> = { Running: 'var(--status-ok)', Pending: 'var(--status-pending)', Succeeded: 'var(--text-muted)', Failed: 'var(--status-danger)', Terminating: 'var(--status-warn)', Unknown: 'var(--text-secondary)' };

export function PodDistribution({ phases, count }: { phases: Record<string, number>; count: number | null | undefined }) {
  const id = useId();
  let offset = 0;
  return <OverviewSection label="Pod phases" title="Pod distribution" description="Current lifecycle phases in this scope">
    {count == null ? <p className="overview-muted">Pod data unavailable or synchronizing.</p> : <div className="overview-pod-distribution">
      <svg viewBox="0 0 140 140" className="overview-donut" role="img" aria-labelledby={id}>
        <title id={id}>{count === 0 ? 'No Pods in this scope' : `${count} Pods: ${Object.entries(phases).map(([phase, value]) => `${value} ${phase.toLowerCase()}`).join(', ')}`}</title>
        <circle cx="70" cy="70" r="54" fill="none" stroke="var(--border-subtle)" strokeWidth="12" />
        {Object.entries(phases).map(([phase, value]) => {
          const fraction = count ? value / count : 0;
          const start = offset; offset += fraction * 100;
          return value > 0 && <circle key={phase} cx="70" cy="70" r="54" pathLength="100" fill="none" stroke={colors[phase]} strokeWidth="12" strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`} strokeDashoffset={-start} transform="rotate(-90 70 70)" />;
        })}
        <text x="70" y="69" textAnchor="middle" className="overview-donut-count">{count.toLocaleString()}</text>
        <text x="70" y="89" textAnchor="middle" className="overview-donut-label">total Pods</text>
      </svg>
      <dl className="overview-phases">{Object.entries(phases).map(([phase, value]) => <div key={phase}><span className="overview-phase-dot" style={{ background: colors[phase] }} aria-hidden="true" /><dt>{phase}</dt><dd>{value.toLocaleString()}</dd><span className="overview-phase-percent">{count ? Math.round(value / count * 100) : 0}%</span></div>)}</dl>
    </div>}
  </OverviewSection>;
}
