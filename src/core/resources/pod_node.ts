import type { ResourceItem } from '../../types/k8s';

export type PodTargetNodeSource = 'nodeAffinity' | 'nodeSelector';
export type PodPendingNodeSource = PodTargetNodeSource | 'nominated';

export interface PodNodeInfo {
  /** Authoritative scheduled node from spec.nodeName, when bound. */
  assigned?: string;
  /** Preemption candidate node from status.nominatedNodeName, when present. */
  nominated?: string;
  /** Single explicitly pinned target node from required nodeAffinity or nodeSelector. */
  target?: string;
  /** Where `target` came from. */
  targetSource?: PodTargetNodeSource;
  /** Best unscheduled node hint when `assigned` is absent (hard target preferred over nominated). */
  pendingNode?: string;
  pendingSource?: PodPendingNodeSource;
}

export interface AffinityRequirementSummary {
  key: string;
  operator: string;
  values: string[];
  kind: 'field' | 'label';
}

export interface NodeAffinitySummary {
  requiredTerms: AffinityRequirementSummary[][];
  preferredTerms: Array<{ weight: number; requirements: AffinityRequirementSummary[] }>;
}

export interface PodAffinitySummary {
  required: Array<{ topologyKey: string; namespaces?: string[]; selector: string }>;
  preferred: Array<{ weight: number; topologyKey: string; namespaces?: string[]; selector: string }>;
}

export interface PodAffinityDetails {
  nodeAffinity?: NodeAffinitySummary;
  podAffinity?: PodAffinitySummary;
  podAntiAffinity?: PodAffinitySummary;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== '-' ? trimmed : undefined;
}

function singlePinnedValue(terms: any[], field: 'matchFields' | 'matchExpressions', key: string): string | undefined {
  if (!Array.isArray(terms) || terms.length === 0) return undefined;
  let pinned: string | undefined;
  for (const term of terms) {
    const reqs = Array.isArray(term?.[field]) ? term[field] : [];
    let allowed: Set<string> | undefined;
    for (const req of reqs) {
      if (req?.key !== key || req?.operator !== 'In') continue;
      const values = new Set<string>(
        (Array.isArray(req.values) ? req.values : [])
          .map((v: unknown) => nonEmpty(v))
          .filter((v: string | undefined): v is string => !!v)
      );
      allowed = allowed ? new Set([...allowed].filter((v) => values.has(v))) : values;
    }
    if (!allowed || allowed.size !== 1) return undefined;
    const [candidate] = [...allowed];
    if (pinned === undefined) pinned = candidate;
    else if (pinned !== candidate) return undefined;
  }
  return pinned;
}

/**
 * Extract a single explicitly pinned target node from a PodSpec:
 * 1. DaemonSet / required nodeAffinity `matchFields` (`metadata.name In [node]`) across every term
 * 2. Required nodeAffinity `matchExpressions` (`kubernetes.io/hostname In [node]`) across every term
 * 3. `spec.nodeSelector["kubernetes.io/hostname"]`
 */
export function extractPinnedPodNode(
  spec: Record<string, any> | undefined
): { node: string; source: PodTargetNodeSource } | undefined {
  if (!spec || typeof spec !== 'object') return undefined;
  const terms = spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (Array.isArray(terms) && terms.length > 0) {
    const byField = singlePinnedValue(terms, 'matchFields', 'metadata.name');
    if (byField) return { node: byField, source: 'nodeAffinity' };
    const byHostname = singlePinnedValue(terms, 'matchExpressions', 'kubernetes.io/hostname');
    if (byHostname) return { node: byHostname, source: 'nodeAffinity' };
  }
  const host = nonEmpty(spec.nodeSelector?.['kubernetes.io/hostname']);
  if (host) return { node: host, source: 'nodeSelector' };
  return undefined;
}

export function podNodeInfo(itemOrRaw: ResourceItem | Record<string, any> | undefined): PodNodeInfo {
  if (!itemOrRaw || typeof itemOrRaw !== 'object') return {};
  const item = itemOrRaw as ResourceItem;
  const raw = item.raw && typeof item.raw === 'object' ? item.raw : itemOrRaw;
  const spec = (raw as any)?.spec ?? item.spec;
  const status = (raw as any)?.status ?? item.statusRaw;

  const assigned = nonEmpty(spec?.nodeName) ?? nonEmpty(item.node);
  const nominated = nonEmpty(status?.nominatedNodeName);
  const pinned = extractPinnedPodNode(spec);

  const fallbackTarget = !pinned && item.targetNodeSource && item.targetNodeSource !== 'nominated'
    ? nonEmpty(item.targetNode)
    : undefined;
  const target = pinned?.node ?? fallbackTarget;
  const targetSource: PodTargetNodeSource | undefined = pinned?.source
    ?? (fallbackTarget && (item.targetNodeSource === 'nodeAffinity' || item.targetNodeSource === 'nodeSelector')
      ? item.targetNodeSource
      : undefined);

  const effectiveNominated = nominated ?? (!target && item.targetNodeSource === 'nominated' ? nonEmpty(item.targetNode) : undefined);

  const pendingNode = assigned ? undefined : (target ?? effectiveNominated);
  const pendingSource: PodPendingNodeSource | undefined = assigned
    ? undefined
    : target
      ? targetSource
      : effectiveNominated
        ? 'nominated'
        : undefined;

  return {
    assigned,
    nominated: effectiveNominated,
    target,
    targetSource,
    pendingNode,
    pendingSource,
  };
}

export function podNodeSourceLabel(source: PodPendingNodeSource | undefined): string {
  switch (source) {
    case 'nodeAffinity': return 'pinned via nodeAffinity';
    case 'nodeSelector': return 'pinned via nodeSelector';
    case 'nominated': return 'nominated for preemption';
    default: return 'target node';
  }
}

export function formatAffinityRequirement(req: AffinityRequirementSummary): string {
  if (req.operator === 'Exists' || req.operator === 'DoesNotExist') {
    return `${req.key} ${req.operator}`;
  }
  if (req.operator === 'In' && req.values.length === 1) {
    return `${req.key}=${req.values[0]}`;
  }
  return `${req.key} ${req.operator} [${req.values.join(', ')}]`;
}

function parseTermRequirements(term: any): AffinityRequirementSummary[] {
  const out: AffinityRequirementSummary[] = [];
  for (const field of Array.isArray(term?.matchFields) ? term.matchFields : []) {
    if (!field?.key) continue;
    out.push({
      key: String(field.key),
      operator: String(field.operator ?? 'In'),
      values: Array.isArray(field.values) ? field.values.map(String) : [],
      kind: 'field',
    });
  }
  for (const expr of Array.isArray(term?.matchExpressions) ? term.matchExpressions : []) {
    if (!expr?.key) continue;
    out.push({
      key: String(expr.key),
      operator: String(expr.operator ?? 'In'),
      values: Array.isArray(expr.values) ? expr.values.map(String) : [],
      kind: 'label',
    });
  }
  return out;
}

function formatLabelSelector(selector: any): string {
  if (!selector || typeof selector !== 'object') return '*';
  const parts: string[] = [];
  if (selector.matchLabels && typeof selector.matchLabels === 'object') {
    for (const [k, v] of Object.entries(selector.matchLabels)) {
      parts.push(`${k}=${String(v)}`);
    }
  }
  for (const expr of Array.isArray(selector.matchExpressions) ? selector.matchExpressions : []) {
    if (!expr?.key) continue;
    parts.push(
      formatAffinityRequirement({
        key: String(expr.key),
        operator: String(expr.operator ?? 'In'),
        values: Array.isArray(expr.values) ? expr.values.map(String) : [],
        kind: 'label',
      })
    );
  }
  return parts.length > 0 ? parts.join(', ') : '*';
}

function parsePodAffinity(section: any): PodAffinitySummary | undefined {
  if (!section || typeof section !== 'object') return undefined;
  const required = (Array.isArray(section.requiredDuringSchedulingIgnoredDuringExecution)
    ? section.requiredDuringSchedulingIgnoredDuringExecution
    : []
  ).map((term: any) => ({
    topologyKey: String(term?.topologyKey ?? '—'),
    namespaces: Array.isArray(term?.namespaces) && term.namespaces.length > 0 ? term.namespaces.map(String) : undefined,
    selector: formatLabelSelector(term?.labelSelector),
  }));
  const preferred = (Array.isArray(section.preferredDuringSchedulingIgnoredDuringExecution)
    ? section.preferredDuringSchedulingIgnoredDuringExecution
    : []
  ).map((entry: any) => ({
    weight: Number(entry?.weight ?? 0),
    topologyKey: String(entry?.podAffinityTerm?.topologyKey ?? '—'),
    namespaces: Array.isArray(entry?.podAffinityTerm?.namespaces) && entry.podAffinityTerm.namespaces.length > 0
      ? entry.podAffinityTerm.namespaces.map(String)
      : undefined,
    selector: formatLabelSelector(entry?.podAffinityTerm?.labelSelector),
  }));
  if (required.length === 0 && preferred.length === 0) return undefined;
  return { required, preferred };
}

export function summarizePodAffinity(affinity: Record<string, any> | undefined): PodAffinityDetails | undefined {
  if (!affinity || typeof affinity !== 'object') return undefined;
  let nodeAffinity: NodeAffinitySummary | undefined;
  if (affinity.nodeAffinity && typeof affinity.nodeAffinity === 'object') {
    const reqTerms = (
      Array.isArray(affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms)
        ? affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms
        : []
    )
      .map(parseTermRequirements)
      .filter((reqs: AffinityRequirementSummary[]) => reqs.length > 0);

    const prefTerms = (
      Array.isArray(affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution)
        ? affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution
        : []
    )
      .map((entry: any) => ({
        weight: Number(entry?.weight ?? 0),
        requirements: parseTermRequirements(entry?.preference),
      }))
      .filter((entry: { weight: number; requirements: AffinityRequirementSummary[] }) => entry.requirements.length > 0);

    if (reqTerms.length > 0 || prefTerms.length > 0) {
      nodeAffinity = { requiredTerms: reqTerms, preferredTerms: prefTerms };
    }
  }

  const podAffinity = parsePodAffinity(affinity.podAffinity);
  const podAntiAffinity = parsePodAffinity(affinity.podAntiAffinity);

  if (!nodeAffinity && !podAffinity && !podAntiAffinity) return undefined;
  return { nodeAffinity, podAffinity, podAntiAffinity };
}
