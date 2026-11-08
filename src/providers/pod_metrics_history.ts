import type { PodMetric } from './overview_metrics';
import { quantity } from '../core/resources/quantities';
import { appendHistory, type HistoryPoint } from '../core/resources/telemetry';

export function podMetricUsage(metric?: PodMetric): Pick<HistoryPoint, 'cpu' | 'memory'> {
  const sum = (dimension: 'cpu' | 'memory'): number | null => {
    if (!metric?.containers.length) return null;
    let total = 0;
    for (const container of metric.containers) {
      const value = quantity(container[dimension]);
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  return { cpu: sum('cpu'), memory: sum('memory') };
}
export function podMetricPoint(metric: PodMetric | undefined, createdAt: number, now = Date.now()): HistoryPoint | undefined {
  if (!metric) return;
  const at = Date.parse(metric.timestamp);
  if (!Number.isFinite(at) || at < createdAt || now - at > 120000 || at - now > 30000) return;
  const usage = podMetricUsage(metric);
  if (usage.cpu === null || usage.memory === null) return;
  return { at, ...usage };
}
/** Only viewed Pods retain history: bounded by Pod identity as well as observation count/time. */
export class PodMetricsHistory {
  private entries = new Map<string, HistoryPoint[]>();
  get(key: string): HistoryPoint[] { return this.entries.get(key) ?? []; }
  record(key: string, point: HistoryPoint | undefined, createdAt: number): HistoryPoint[] {
    const previous = this.entries.get(key) ?? [];
    const relevant = previous.some(sample => sample.at < createdAt) ? previous.filter(sample => sample.at >= createdAt) : previous;
    const points = appendHistory(relevant, point);
    this.entries.delete(key); this.entries.set(key, points);
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
    return points;
  }
}
