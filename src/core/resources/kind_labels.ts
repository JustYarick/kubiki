/**
 * Human readable names for Kubernetes kinds.
 *
 * Detail panels, tables and headers must not show raw CamelCase identifiers
 * ("MutatingWebhookConfiguration summary"); they use the same wording as the
 * Kubernetes documentation and the Lens resource catalogue.
 */
const KNOWN_NAMES: Record<string, string> = {
  HorizontalPodAutoscaler: 'Horizontal pod autoscaler',
  VerticalPodAutoscaler: 'Vertical pod autoscaler',
  PodDisruptionBudget: 'Pod disruption budget',
  ResourceQuota: 'Resource quota',
  LimitRange: 'Limit range',
  PriorityClass: 'Priority class',
  RuntimeClass: 'Runtime class',
  IngressClass: 'Ingress class',
  EndpointSlice: 'Endpoint slice',
  NetworkPolicy: 'Network policy',
  MutatingWebhookConfiguration: 'Mutating webhook configuration',
  ValidatingWebhookConfiguration: 'Validating webhook configuration',
  ValidatingAdmissionPolicy: 'Validating admission policy',
  MutatingAdmissionPolicy: 'Mutating admission policy',
  ValidatingAdmissionPolicyBinding: 'Validating admission policy binding',
  MutatingAdmissionPolicyBinding: 'Mutating admission policy binding',
  DeviceClass: 'Device class',
  ResourceClaim: 'Resource claim',
  ResourceClaimTemplate: 'Resource claim template',
  ResourceSlice: 'Resource slice',
  CRD: 'Custom resource definition',
};

/** "MutatingWebhookConfiguration" → "Mutating webhook configuration", "HTTPRoute" → "HTTP route". */
export function friendlyKindName(kind: string): string {
  if (KNOWN_NAMES[kind]) return KNOWN_NAMES[kind];
  const spaced = kind
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = spaced
    .split(' ')
    .filter(Boolean)
    .map(word => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));
  if (!words.length) return kind;
  return `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}`.trim();
}

/** Section title used by every details panel summary, e.g. "Resource quota summary". */
export function summaryTitle(kind: string): string {
  return `${friendlyKindName(kind)} summary`;
}

/** Plural wording for counters, e.g. "2 webhooks", "1 endpoint". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
