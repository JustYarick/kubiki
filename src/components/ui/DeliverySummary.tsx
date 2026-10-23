import { CheckCircle2, CircleHelp, CirclePause, Layers, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';

export interface DeliveryMetric { id: string; label: string; value: number | null; detail: string; tone?: 'ok' | 'warn' | 'pending' | 'muted'; icon?: LucideIcon }
export const deliveryIcons = { healthy: CheckCircle2, attention: TriangleAlert, progressing: LoaderCircle, suspended: CirclePause, unknown: CircleHelp };

export function DeliverySummary({ metrics, active, onSelect }: { metrics: DeliveryMetric[]; active: string; onSelect: (id: string) => void }) {
  return <div className="delivery-summary" role="group" aria-label="Filter by status">{metrics.map(metric => {
    const Icon = metric.icon ?? Layers;
    return <button key={metric.id} className="delivery-metric" data-tone={metric.tone} aria-pressed={active === metric.id} onClick={() => onSelect(metric.id)}>
      <span className="delivery-metric-label"><Icon size={14} aria-hidden="true" />{metric.label}</span>
      <span className="delivery-metric-value">{metric.value == null ? '—' : metric.value.toLocaleString()}</span>
      <span className="delivery-metric-detail">{metric.detail}</span>
    </button>;
  })}</div>;
}
