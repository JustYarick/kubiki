import type { HelmDocument, HelmHistory, HelmReleasePage } from '../helm_types';

const charts = [
  { name: 'ingress-nginx', namespace: 'kube-system', revision: '3', updated: '2026-10-20 10:00:00 +0000 UTC', status: 'deployed', chart: 'ingress-nginx-4.12.0', app_version: '1.12.0' },
  { name: 'demo-api', namespace: 'backend', revision: '2', updated: '2026-10-20 09:00:00 +0000 UTC', status: 'failed', chart: 'demo-api-1.4.0', app_version: '1.4.0' },
];
export function demoHelmPage(context: string, namespace: string | null, offset: number): HelmReleasePage {
  return { context, namespace, offset, limit: 100, has_more: false, items: charts.filter(item => !namespace || item.namespace === namespace).slice(offset, offset + 100) };
}
export function demoHelmHistory(name: string): HelmHistory[] {
  const chart = charts.find(chart => chart.name === name)!;
  return Array.from({ length: Number(chart.revision) }, (_, i) => ({ revision: i + 1, updated: chart.updated, status: i + 1 === Number(chart.revision) ? chart.status : 'superseded', chart: chart.chart, app_version: chart.app_version, description: i ? 'Upgrade complete' : 'Install complete' }));
}
export function demoHelmContent(name: string, namespace: string, revision: number, document: HelmDocument): string {
  if (document === 'values') return `replicaCount: 2\nimage:\n  repository: ghcr.io/kubiki/${name}\n  tag: demo\n`;
  if (document === 'notes') return `Demo release ${name} · revision ${revision}\nThis is simulated data; no Helm command was executed.`;
  return `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nspec:\n  replicas: 2\n`;
}
