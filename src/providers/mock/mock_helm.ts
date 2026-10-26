import type { HelmDocument, HelmHistory, HelmReleasePage } from '../helm_types';
import { stringify } from 'yaml';
import { PRODUCTION_WORKLOADS } from './mock_cluster_profile';

const at = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const charts = [
  { name: 'ingress-nginx', namespace: 'kube-system', revision: '3', status: 'deployed', chart: 'ingress-nginx-4.12.0', app_version: '1.12.0', minutes: 90, object: 'ingress-nginx-controller', kind: 'Deployment' },
  { name: 'demo-api', namespace: 'backend', revision: '2', status: 'failed', chart: 'demo-api-1.4.0', app_version: '1.4.0', minutes: 12, object: 'payment-worker', kind: 'Deployment' },
  { name: 'prometheus', namespace: 'monitoring', revision: '5', status: 'deployed', chart: 'kube-prometheus-stack-65.1.0', app_version: 'v2.55.0', minutes: 80, object: 'prometheus-server', kind: 'StatefulSet' },
  { name: 'redis-cache', namespace: 'backend', revision: '4', status: 'deployed', chart: 'redis-20.2.0', app_version: '7.4.1', minutes: 60, object: 'redis-cache', kind: 'StatefulSet' },
  { name: 'loki', namespace: 'logging', revision: '3', status: 'failed', chart: 'loki-6.20.0', app_version: '3.2.0', minutes: 15, object: 'loki', kind: 'StatefulSet' },
  { name: 'web-frontend', namespace: 'frontend', revision: '2', status: 'pending-upgrade', chart: 'web-2.3.0', app_version: '2.3.0', minutes: 2, object: 'web-frontend', kind: 'Deployment' },
  { name: 'api-gateway', namespace: 'default', revision: '6', status: 'deployed', chart: 'gateway-1.8.0', app_version: '1.8.0', minutes: 120, object: 'api-gateway', kind: 'Deployment' },
  { name: 'preview-api', namespace: 'staging', revision: '1', status: 'uninstalled', chart: 'api-0.9.0', app_version: '0.9.0', minutes: 180, object: 'preview-api', kind: 'Deployment' },
  ...PRODUCTION_WORKLOADS.map(app => ({ name: app.release, namespace: app.namespace,
    revision: String(2 + app.index % 12), status: 'deployed', chart: `${app.component}-2.4.0`,
    app_version: app.image.split(':')[1], minutes: 60 + app.index * 7, object: app.name, kind: app.kind })),
];
export function demoHelmPage(context: string, namespace: string | null, offset: number): HelmReleasePage {
  const all = charts.filter(item => !namespace || item.namespace === namespace);
  return { context, namespace, offset, limit: 100, has_more: offset + 100 < all.length, items: all.slice(offset, offset + 100).map(({ minutes, object: _object, kind: _kind, ...item }) => ({ ...item, updated: at(minutes) })) };
}
export function demoHelmHistory(name: string): HelmHistory[] {
  const chart = charts.find(chart => chart.name === name);
  if (!chart) return [];
  return Array.from({ length: Number(chart.revision) }, (_, i) => ({ revision: i + 1, updated: at(chart.minutes + (Number(chart.revision) - i - 1) * 1440), status: i + 1 === Number(chart.revision) ? chart.status : 'superseded', chart: chart.chart, app_version: chart.app_version, description: i + 1 !== Number(chart.revision) ? i ? 'Upgrade complete' : 'Install complete' : chart.name === 'loki' ? 'UPGRADE FAILED: pre-upgrade hook loki-migrate failed: BackoffLimitExceeded' : chart.name === 'demo-api' ? 'UPGRADE FAILED: payment-worker did not become ready before the timeout' : chart.status === 'pending-upgrade' ? 'Preparing upgrade; waiting for Deployment readiness' : chart.status === 'uninstalled' ? 'Uninstall complete; history retained' : 'Upgrade complete' }));
}
export function demoHelmContent(name: string, namespace: string, revision: number, document: HelmDocument): string {
  const app = PRODUCTION_WORKLOADS.find(app => app.release === name && app.namespace === namespace);
  if (app && document === 'values') return stringify({ replicaCount: app.replicas, image: { repository: app.image.split(':')[0], tag: app.image.split(':')[1] }, service: { port: app.port }, environment: app.environment });
  if (document === 'values') return `replicaCount: 2\nimage:\n  repository: ghcr.io/kubiki/${name}\n  tag: demo\n`;
  if (document === 'notes') return `Demo release ${name} · revision ${revision}\nThis is simulated data; no Helm command was executed.`;
  if (document === 'hooks') return name === 'loki' ? `apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: loki-migrate\n  namespace: ${namespace}\n  annotations:\n    helm.sh/hook: pre-upgrade\n    helm.sh/hook-weight: "-5"\n    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded\nspec:\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n        - name: migrate\n          image: grafana/loki:3.2.0\n` : '';
  if (app) return stringify({ apiVersion: 'apps/v1', kind: app.kind, metadata: { name: app.name, namespace }, spec: {
    replicas: app.replicas, selector: { matchLabels: { app: app.name } },
    ...(app.kind === 'StatefulSet' ? { serviceName: app.name } : {}),
    template: { metadata: { labels: { app: app.name } }, spec: { containers: [{ name: 'app', image: app.image, ports: [{ containerPort: app.port }] }] } },
  } });
  const chart = charts.find(chart => chart.name === name);
  return `apiVersion: apps/v1\nkind: ${chart?.kind ?? 'Deployment'}\nmetadata:\n  name: ${chart?.object ?? name}\n  namespace: ${namespace}\nspec:\n  replicas: 2\n`;
}
