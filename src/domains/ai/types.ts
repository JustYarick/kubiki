export type AgentMode = 'read_only' | 'ask' | 'accept';
export type AgentPhase = 'plan' | 'tooling' | 'action';
export type ProviderProtocol = 'responses' | 'openai_compatible' | 'anthropic' | 'ollama';
export type DataAccess = 'none' | 'metadata' | 'content';
export type WriteOperation = 'create' | 'update' | 'delete' | 'scale' | 'restart';
export type OptionalToolMode = 'auto' | 'enabled' | 'disabled';

export interface ClusterCapabilities {
  helm: boolean;
  argocd: boolean;
  flux: boolean;
}

export interface ProviderProfile { id: string; name: string; protocol: ProviderProtocol; baseUrl: string }
export interface GenerationOptions { maxOutputTokens?: number | null; temperature?: number | null; toolUse?: boolean | null; contextTokens?: number | null; contextBudgetTokens?: number | null }
export interface ModelInfo { id: string; name: string; contextWindow: number | null; maxOutputTokens: number | null; tools: boolean | null }
export interface AgentScope { context: string; namespaces: string[]; allNamespaces: boolean }
export interface ResourceRule { group: string; kind: string; namespace: string; name: string; read: DataAccess; writes: WriteOperation[] }
export interface AgentPolicy {
  alwaysAsk?: string[];
  confirmReads?: boolean;
  readOnly?: boolean;
  disabledTools?: string[];
  planDisabledTools?: string[];
  actionDisabledTools?: string[];
  schemaVersion?:number;ruleResolution?:'first_match'|'deny_overrides';allowedFields?:string[];
  resources: boolean; events: boolean; logs: boolean; metrics: boolean;
  clusterResources: boolean; secrets: DataAccess; configMaps: DataAccess;
  workloadConfiguration: boolean; annotations: boolean; customResources: DataAccess;
  helm: OptionalToolMode; argocd: OptionalToolMode; flux: OptionalToolMode;
  contexts: string[]; namespaces: string[]; writes: WriteOperation[];
  maxReplicas: number; rules: ResourceRule[]; deniedPaths: string[];
}
export interface SkillInfo { name: string; description: string; directory: string }
export type AgentRuntime = 'kubiki' | 'open_code' | 'codex' | 'claude';
export interface OpenCodeSettings { executable: string; workingDirectory: string }

export const AI_SETTINGS_PAGES = [
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'Cluster tools (MCP)' },
  { id: 'providers', label: 'Connections & models' },
  { id: 'history', label: 'History' },
  { id: 'environment', label: 'Environment' },
  { id: 'access', label: 'Data access' },
  { id: 'scope', label: 'Scope & rules' },
  { id: 'confirmations', label: 'Confirmations' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'instructions', label: 'Instructions' },
] as const;

export type AgentSettingsPage = typeof AI_SETTINGS_PAGES[number]['id'];
export interface AiSettings {
  runtime?: AgentRuntime;
  opencode?: OpenCodeSettings;
  codex?: OpenCodeSettings;
  claude?: OpenCodeSettings;
  mcpPolicy?: AgentPolicy;
  /** Inert legacy configuration, retained for lossless migration. */
  environment?: unknown;
  providers: ProviderProfile[]; defaultProvider: string | null; defaultModel: string | null;
  options: GenerationOptions; policy: AgentPolicy; instructions: string;
}
export type PlanStatus = 'draft' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale' | 'partial';

export interface PlanStep { id:string;title:string;action:'inspect'|'manual'|'scale'|'restart'|'apply'|'delete';target?:{group:string;version:string;kind:string;namespace:string|null;name:string}|null;expectedUid?:string|null;replicas?:number|null;yaml?:string|null;reason:string;verification:string;risk:string;dependsOn?:string[];dependsOnAccepted?:string[] }
export interface PlanArtifact {
  schemaVersion:1;
  sessionId:string;
  kind:'remediation'|'investigation'|'deployment';
  diagnosis:string;uncertainty:string;steps:PlanStep[];
  id: string;
  version: number;
  title: string;
  bodyMarkdown: string;
  targetScope?: string | null;
  scope: AgentScope;
  evidenceIds?: string[];
  proposedActions?: string[];
  status?: PlanStatus;
  policyRevision?: number;
  createdAt: string;
}

export interface SettingsView { settings: AiSettings; credentials: Record<string, boolean> }
export interface SessionView { id: string; scope: AgentScope; mode: AgentMode; phase: AgentPhase; policy: AgentPolicy }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type AgentEvent =
  | { type: 'status'; status: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; call: ToolCall }
  | { type: 'tool_completed'; id: string; result: Record<string, unknown> }
  | { type: 'plan_updated'; plan: PlanArtifact }
  | { type: 'context'; estimatedInputTokens: number; budgetTokens: number; reservedOutputTokens: number }
  | ({ type: 'generation_metrics' } & GenerationMetrics)
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'error'; message: string };
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  call?: ToolCall;
  result?: Record<string, unknown>;
  planArtifact?: PlanArtifact;
  model?: string;
  phase?: AgentPhase;
  startTime?: number;
  durationMs?: number;
  outputTokens?: number;
  tokensPerSec?: number;
}
export interface GenerationMetrics {
  id: string; model: string; phase: AgentPhase;
  systemTokens: number; toolTokens: number; historyTokens: number;
  inputTokens: number | null; outputTokens: number | null;
  durationMs: number; toolCount: number;
  resolvedModel?: string | null; cachedInputTokens?: number | null; reasoningOutputTokens?: number | null; firstTokenMs?: number | null;
}
export interface Conversation {
  id: string; sessionId?: string; title: string; scope: AgentScope;
  intent?: 'chat' | 'investigate' | 'create';
  providerId: string; model: string; mode: AgentMode; phase: AgentPhase; messages: ChatMessage[];
  draft: string; status: string; error?: string; busy: boolean; invalidated?: boolean;
  generationMetrics?: GenerationMetrics[];
  inputTokens: number; outputTokens: number;
  currentContextTokens?: number;
  contextBudgetTokens?: number;
  contextEstimated?: boolean;
  reservedOutputTokens?: number;
  contextReset?: boolean;
  activePlan?: PlanArtifact;
  archived?: boolean;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export const WRITE_OPERATIONS: WriteOperation[] = ['create', 'update', 'delete', 'scale', 'restart'];
export const MODE_LABELS = { ask: 'Ask', accept: 'Auto accept' };
export const PHASE_LABELS: Record<string, string> = { plan: 'Plan', tooling: 'Action', action: 'Action' };

export function defaultPolicy(): AgentPolicy {
  return { confirmReads: false, readOnly: false, disabledTools: [], planDisabledTools: [], actionDisabledTools: [], resources: true, events: true, logs: false, metrics: true, clusterResources: false,
    secrets: 'none', configMaps: 'metadata', workloadConfiguration: false, annotations: false,
    customResources: 'metadata', helm: 'auto', argocd: 'auto', flux: 'auto', contexts: ['*'], namespaces: ['*'],
    writes: [], maxReplicas: 10,
    rules: [], deniedPaths: [] };
}

export function defaultMcpPolicy(): AgentPolicy {
  return {
    ...defaultPolicy(),
    logs: true,
    clusterResources: true,
    writes: ['create', 'update', 'delete', 'scale', 'restart'],
  };
}

export function normalizeMcpPolicy(policy?: AgentPolicy): AgentPolicy {
  if (!policy) return defaultMcpPolicy();
  const isLegacyUnconfigured =
    !policy.readOnly &&
    (!policy.writes || policy.writes.length === 0) &&
    !policy.logs &&
    !policy.clusterResources &&
    (!policy.disabledTools || policy.disabledTools.length === 0) &&
    (!policy.planDisabledTools || policy.planDisabledTools.length === 0) &&
    (!policy.actionDisabledTools || policy.actionDisabledTools.length === 0);
  const writes = isLegacyUnconfigured
    ? (['create', 'update', 'delete', 'scale', 'restart'] as WriteOperation[])
    : (policy.writes ?? []);
  return {
    ...policy,
    logs: isLegacyUnconfigured ? true : Boolean(policy.logs),
    clusterResources: isLegacyUnconfigured ? true : Boolean(policy.clusterResources),
    writes,
    disabledTools: policy.disabledTools ?? [],
    planDisabledTools: policy.planDisabledTools ?? [],
    actionDisabledTools: policy.actionDisabledTools ?? [],
  };
}

export function syncSharedPolicyFields(source: AgentPolicy, target: AgentPolicy): AgentPolicy {
  return {
    ...target,
    readOnly: source.readOnly,
    writes: source.writes,
    logs: source.logs,
    clusterResources: source.clusterResources,
    resources: source.resources,
    events: source.events,
    metrics: source.metrics,
    secrets: source.secrets,
    configMaps: source.configMaps,
    customResources: source.customResources,
    maxReplicas: source.maxReplicas,
    contexts: source.contexts,
    namespaces: source.namespaces,
    deniedPaths: source.deniedPaths,
    helm: source.helm,
    argocd: source.argocd,
    flux: source.flux,
    disabledTools: source.disabledTools,
    planDisabledTools: source.planDisabledTools,
    actionDisabledTools: source.actionDisabledTools,
  };
}

export function isToolActiveInPolicy(toolId: string, policy: AgentPolicy, phase?: AgentPhase): boolean {
  if (policy.disabledTools?.includes(toolId)) return false;
  if (phase === 'plan' && policy.planDisabledTools?.includes(toolId)) return false;
  if (phase === 'action' && policy.actionDisabledTools?.includes(toolId)) return false;

  // In Plan mode, write/mutation tools are never active
  const isWriteTool = ['apply_manifest', 'scale_workload', 'restart_workload', 'delete_resource'].includes(toolId);
  if (phase === 'plan' && isWriteTool) return false;

  switch (toolId) {
    case 'apply_manifest':
      return !policy.readOnly && (policy.writes.includes('create') || policy.writes.includes('update'));
    case 'scale_workload':
      return !policy.readOnly && policy.writes.includes('scale');
    case 'restart_workload':
      return !policy.readOnly && policy.writes.includes('restart');
    case 'delete_resource':
      return !policy.readOnly && policy.writes.includes('delete');
    case 'get_logs':
      return Boolean(policy.logs);
    case 'get_node_diagnostics':
      return Boolean(policy.resources && policy.clusterResources);
    case 'get_events':
    case 'get_events_timeline':
      return Boolean(policy.events);
    case 'get_metrics':
      return Boolean(policy.metrics);
    case 'list_helm_releases':
    case 'get_helm_release':
      return policy.helm !== 'disabled';
    case 'list_argocd_apps':
    case 'get_argocd_app':
      return Boolean(policy.resources) && policy.argocd !== 'disabled';
    case 'list_flux_resources':
    case 'get_flux_resource':
      return Boolean(policy.resources) && policy.flux !== 'disabled';
    case 'propose_manifests':
      return true;
    default:
      return Boolean(policy.resources);
  }
}

export function toggleReadOnlyMcpPolicy(readOnly: boolean, policy: AgentPolicy): AgentPolicy {
  const writes = !readOnly && (!policy.writes || policy.writes.length === 0)
    ? (['create', 'update', 'delete', 'scale', 'restart'] as WriteOperation[])
    : policy.writes;
  return {
    ...policy,
    readOnly,
    writes,
  };
}

export function patchToolInPolicy(toolId: string, enabled: boolean, policy: AgentPolicy, phase?: AgentPhase): AgentPolicy {
  let next: AgentPolicy = { ...policy };

  if (phase === 'plan') {
    const planDisabled = next.planDisabledTools ?? [];
    next.planDisabledTools = enabled
      ? planDisabled.filter(id => id !== toolId)
      : Array.from(new Set([...planDisabled, toolId]));
    if (enabled && next.disabledTools?.includes(toolId)) {
      next.disabledTools = next.disabledTools.filter(id => id !== toolId);
    }
  } else if (phase === 'action') {
    const actionDisabled = next.actionDisabledTools ?? [];
    next.actionDisabledTools = enabled
      ? actionDisabled.filter(id => id !== toolId)
      : Array.from(new Set([...actionDisabled, toolId]));
    if (enabled && next.disabledTools?.includes(toolId)) {
      next.disabledTools = next.disabledTools.filter(id => id !== toolId);
    }
  } else {
    const disabledTools = next.disabledTools ?? [];
    next.disabledTools = enabled
      ? disabledTools.filter(id => id !== toolId)
      : Array.from(new Set([...disabledTools, toolId]));
    if (enabled) {
      next.planDisabledTools = (next.planDisabledTools ?? []).filter(id => id !== toolId);
      next.actionDisabledTools = (next.actionDisabledTools ?? []).filter(id => id !== toolId);
    }
  }

  if (enabled) {
    switch (toolId) {
      case 'apply_manifest':
        next.readOnly = false;
        next.writes = Array.from(new Set([...next.writes, 'create', 'update' as WriteOperation]));
        break;
      case 'scale_workload':
        next.readOnly = false;
        next.writes = Array.from(new Set([...next.writes, 'scale' as WriteOperation]));
        break;
      case 'restart_workload':
        next.readOnly = false;
        next.writes = Array.from(new Set([...next.writes, 'restart' as WriteOperation]));
        break;
      case 'delete_resource':
        next.readOnly = false;
        next.writes = Array.from(new Set([...next.writes, 'delete' as WriteOperation]));
        break;
      case 'get_logs':
        next.logs = true;
        break;
      case 'get_node_diagnostics':
        next.resources = true;
        next.clusterResources = true;
        break;
      case 'get_events':
      case 'get_events_timeline':
        next.events = true;
        break;
      case 'get_metrics':
        next.metrics = true;
        break;
      case 'list_helm_releases':
      case 'get_helm_release':
        if (next.helm === 'disabled') next.helm = 'auto';
        break;
      case 'list_argocd_apps':
      case 'get_argocd_app':
        next.resources = true;
        if (next.argocd === 'disabled') next.argocd = 'auto';
        break;
      case 'list_flux_resources':
      case 'get_flux_resource':
        next.resources = true;
        if (next.flux === 'disabled') next.flux = 'auto';
        break;
      default:
        next.resources = true;
        break;
    }
  }

  return next;
}

export interface McpToolCatalogEntry {
  id: string;
  label: string;
  group: 'read' | 'write';
  description: string;
}

export const MCP_TOOL_CATALOG: McpToolCatalogEntry[] = [
  { id: 'diagnose_resource', label: 'Diagnose resource', group: 'read', description: 'Comprehensive health bundle: status, relationships, recent warning events, and logs of failing containers' },
  { id: 'get_resource', label: 'Get resource', group: 'read', description: 'Read a specific Kubernetes resource manifest or selected fields by group, version, kind and name' },
  { id: 'list_resources', label: 'List resources', group: 'read', description: 'List resources with label and field selectors, namespace filtering, and cursor pagination' },
  { id: 'summarize_resources', label: 'Summarize resources', group: 'read', description: 'Generate high-level counts, status breakdown and example objects for a resource kind' },
  { id: 'list_namespaces', label: 'List namespaces', group: 'read', description: 'Discover accessible namespaces in the connected cluster' },
  { id: 'get_neighborhood', label: 'Neighborhood graph', group: 'read', description: 'Traverse owner references, parent controllers, linked services, pods, and storage relationships' },
  { id: 'get_pod_diagnostics', label: 'Pod diagnostics', group: 'read', description: 'Detailed pod health: container states, probe failures, restart reasons, and scheduling errors' },
  { id: 'get_workload_diagnostics', label: 'Workload diagnostics', group: 'read', description: 'Deployment, StatefulSet or DaemonSet rollout status, conditions, revisions, and replica mismatch' },
  { id: 'get_service_diagnostics', label: 'Service diagnostics', group: 'read', description: 'Inspect Service ports, selector matching, EndpointSlices, and ready backend pods' },
  { id: 'get_pvc_diagnostics', label: 'PVC diagnostics', group: 'read', description: 'PersistentVolumeClaim binding status, StorageClass capacity, volume attributes, and mount events' },
  { id: 'get_node_diagnostics', label: 'Node diagnostics', group: 'read', description: 'Node conditions (Ready, MemoryPressure, DiskPressure), taints, allocatable capacity, and daemon pods' },
  { id: 'get_config_diagnostics', label: 'Config reference diagnostics', group: 'read', description: 'Validate presence and keys of referenced ConfigMaps and Secrets without exposing values' },
  { id: 'resource_catalog', label: 'Resource catalog', group: 'read', description: 'Explore available API resource types, preferred API versions, and installed CRDs' },
  { id: 'get_events', label: 'Get events', group: 'read', description: 'Fetch recent Kubernetes warning and informational events in a namespace' },
  { id: 'get_events_timeline', label: 'Events timeline', group: 'read', description: 'Chronological timeline of events with deduplication and frequency counts' },
  { id: 'get_logs', label: 'Pod logs', group: 'read', description: 'Stream container logs with support for tail lines, timestamps, and previous crash logs' },
  { id: 'get_metrics', label: 'Pod metrics', group: 'read', description: 'Read real-time CPU and memory usage statistics for pods and containers' },
  { id: 'list_helm_releases', label: 'List Helm releases', group: 'read', description: 'List deployed Helm releases across permitted namespaces' },
  { id: 'get_helm_release', label: 'Get Helm release', group: 'read', description: 'Inspect Helm release values, revision history, release manifest, and chart metadata' },
  { id: 'list_argocd_apps', label: 'List Argo CD apps', group: 'read', description: 'List Argo CD applications, sync status, and destination clusters' },
  { id: 'get_argocd_app', label: 'Get Argo CD app', group: 'read', description: 'Argo CD application health, sync state, Git source repo, revision, and managed resource tree' },
  { id: 'list_flux_resources', label: 'List Flux resources', group: 'read', description: 'List Flux Kustomizations, HelmReleases, and GitRepositories' },
  { id: 'get_flux_resource', label: 'Get Flux resource', group: 'read', description: 'Inspect Flux resource reconciliation status, applied commit, and dependency health' },
  { id: 'verify_workload', label: 'Verify workload', group: 'read', description: 'Verify controller state, generation, and replica availability following a mutation' },
  { id: 'get_evidence', label: 'Get evidence', group: 'read', description: 'Retrieve diagnostic bundle gathered in an earlier step of this investigation' },
  { id: 'set_working_scope', label: 'Set working scope', group: 'read', description: 'Set current active namespace and target root resource for the session' },
  { id: 'propose_manifests', label: 'Propose manifests', group: 'read', description: 'Generate and review proposed Kubernetes manifests without applying them' },
  { id: 'apply_manifest', label: 'Apply manifest', group: 'write', description: 'Server-side apply Kubernetes manifest (create or update resources)' },
  { id: 'scale_workload', label: 'Scale workload', group: 'write', description: 'Scale replica count of a Deployment, StatefulSet, or ReplicaSet' },
  { id: 'restart_workload', label: 'Restart workload', group: 'write', description: 'Trigger rolling restart of a Deployment, DaemonSet, or StatefulSet' },
  { id: 'delete_resource', label: 'Delete resource', group: 'write', description: 'Delete a specific Kubernetes resource by group, version, kind, namespace, and name' },
];
export function defaultSettings(): AiSettings {
  return { runtime: 'kubiki', providers: [], defaultProvider: null, defaultModel: null, options: {}, policy: defaultPolicy(), instructions: '' };
}

/** These are connection presets, never a catalog of available model IDs. */
export const PROVIDER_PRESETS: Array<{ name: string; protocol: ProviderProtocol; baseUrl: string }> = [
  { name: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Ollama', protocol: 'ollama', baseUrl: 'http://localhost:11434' },
  { name: 'LM Studio', protocol: 'openai_compatible', baseUrl: 'http://localhost:1234/v1' },
  { name: 'OpenRouter', protocol: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'DeepSeek', protocol: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Mistral', protocol: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1' },
  { name: 'Groq', protocol: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'Gemini', protocol: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'Custom / vLLM / llama.cpp', protocol: 'openai_compatible', baseUrl: 'http://localhost:8000/v1' },
];

export const externalAgentName = (runtime?: AgentRuntime) => runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude Code' : 'OpenCode';
