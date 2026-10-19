export const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';
const MAX_STRUCTURED_LENGTH = 128 * 1024;

export interface AnnotationField {
  path: string;
  value: string;
}

export interface AnnotationValue {
  source: string;
  structured?: Record<string, unknown> | unknown[];
}

/** Annotation values are strings in the API; tolerate structured test/import data too. */
export function parseAnnotationValue(value: unknown): AnnotationValue {
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  const text = source.trim();
  if (text.length > MAX_STRUCTURED_LENGTH || !/^[\[{]/.test(text)) return { source };
  try {
    const structured: unknown = JSON.parse(text);
    if (structured && typeof structured === 'object') return { source, structured: structured as AnnotationValue['structured'] };
  } catch { /* Plain strings may start with a bracket without being JSON. */ }
  return { source };
}

/** Bound the preview, while retaining the complete source for explicit viewing/copy. */
export function annotationFields(value: Record<string, unknown> | unknown[], maxFields = 80): { fields: AnnotationField[]; truncated: boolean } {
  const fields: AnnotationField[] = [];
  let truncated = false;
  const visit = (current: unknown, path: string, depth: number) => {
    if (fields.length >= maxFields) { truncated = true; return; }
    if (current && typeof current === 'object' && Object.keys(current).length) {
      if (depth >= 6) { fields.push({ path, value: Array.isArray(current) ? `Array (${current.length} items)` : `Object (${Object.keys(current).length} keys)` }); truncated = true; return; }
      for (const [key, child] of Object.entries(current)) {
        if (fields.length >= maxFields) { truncated = true; break; }
        visit(child, Array.isArray(current) ? `${path}[${key}]` : path ? `${path}.${key}` : key, depth + 1);
      }
      return;
    }
    fields.push({ path: path || 'Value', value: typeof current === 'object' ? JSON.stringify(current) : String(current) });
  };
  visit(value, '', 0);
  return { fields, truncated };
}

export function lastAppliedSummary(value: Record<string, unknown>): AnnotationField[] {
  const metadata = asRecord(value.metadata);
  const spec = asRecord(value.spec);
  const template = asRecord(asRecord(spec.template).spec);
  const containers = Array.isArray(spec.containers) ? spec.containers : Array.isArray(template.containers) ? template.containers : [];
  const images = containers.map((container) => asRecord(container).image).filter((image): image is string => typeof image === 'string');
  return [
    ['Kind', value.kind], ['API version', value.apiVersion], ['Name', metadata.name], ['Namespace', metadata.namespace],
    ['Replicas', spec.replicas], ['Images', images.length ? images.join('\n') : undefined],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '').map(([path, value]) => ({ path: String(path), value: String(value) }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const ANNOTATION_LABELS: Record<string, string> = {
  'deployment.kubernetes.io/revision': 'Revision',
  'kubernetes.io/change-cause': 'Change cause',
  'kubectl.kubernetes.io/restartedAt': 'Restarted at',
  'kubernetes.io/ingress.class': 'Ingress class',
  'meta.helm.sh/release-name': 'Helm release',
  'meta.helm.sh/release-namespace': 'Helm namespace',
  'prometheus.io/scrape': 'Prometheus scrape',
  'prometheus.io/port': 'Prometheus port',
  'prometheus.io/path': 'Prometheus path',
  [LAST_APPLIED_ANNOTATION]: 'Last applied configuration',
};
