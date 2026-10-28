/** Shared inventory for the resource graph and Helm pages. Keep generation deterministic. */
const domains = [
  'payments', 'catalog', 'checkout', 'identity', 'orders', 'billing', 'shipping',
  'notifications', 'search', 'recommendations', 'analytics', 'fraud', 'inventory',
  'pricing', 'marketplace', 'customers', 'reports', 'media', 'support', 'platform',
];
const components = ['api', 'worker', 'gateway', 'scheduler', 'consumer', 'processor', 'web', 'exporter', 'sync', 'dispatcher'];

export const PRODUCTION_NAMESPACES = domains.flatMap(domain =>
  ['prod', 'staging', 'canary'].map(environment => ({ name: `${domain}-${environment}`, domain, environment })));

export const PRODUCTION_NODES = Array.from({ length: 180 }, (_, index) => ({
  name: `prod-eu-1${'abc'[index % 3]}-${['general', 'compute', 'memory'][Math.floor(index / 3) % 3]}-${String(index + 1).padStart(3, '0')}`,
  zone: `eu-central-1${'abc'[index % 3]}`,
  pool: ['general', 'compute', 'memory'][Math.floor(index / 3) % 3],
}));

export const PRODUCTION_WORKLOADS = PRODUCTION_NAMESPACES.flatMap(({ name: namespace, domain, environment }, nsIndex) =>
  [...components, 'postgres', 'redis'].map((component, componentIndex) => {
    const stateful = componentIndex >= components.length;
    const index = nsIndex * 12 + componentIndex;
    return {
      name: `${domain}-${component}`, namespace, domain, environment, component, index,
      kind: stateful ? 'StatefulSet' as const : 'Deployment' as const,
      replicas: stateful ? 3 : 8 + (componentIndex % 5) * 2,
      release: `${namespace}-${component}`,
      image: component === 'postgres' ? 'postgres:16.3' : component === 'redis' ? 'redis:7.2-alpine' : `ghcr.io/acme/${domain}-${component}:v2.${index % 9}.${index % 17}`,
      port: component === 'postgres' ? 5432 : component === 'redis' ? 6379 : 8080,
    };
  }));
