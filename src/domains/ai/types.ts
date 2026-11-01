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
  schemaVersion?:number;ruleResolution?:'first_match'|'deny_overrides';allowedFields?:string[];
  resources: boolean; events: boolean; logs: boolean; metrics: boolean;
  clusterResources: boolean; secrets: DataAccess; configMaps: DataAccess;
  workloadConfiguration: boolean; annotations: boolean; customResources: DataAccess;
  helm: OptionalToolMode; argocd: OptionalToolMode; flux: OptionalToolMode;
  contexts: string[]; namespaces: string[]; writes: WriteOperation[];
  maxReplicas: number; rules: ResourceRule[]; deniedPaths: string[];
}
export interface AiSettings {
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
export interface Conversation {
  id: string; sessionId?: string; title: string; scope: AgentScope;
  intent?: 'chat' | 'investigate' | 'create';
  providerId: string; model: string; mode: AgentMode; phase: AgentPhase; messages: ChatMessage[];
  draft: string; status: string; error?: string; busy: boolean; invalidated?: boolean;
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
  return { resources: true, events: true, logs: false, metrics: true, clusterResources: false,
    secrets: 'none', configMaps: 'metadata', workloadConfiguration: false, annotations: false,
    customResources: 'metadata', helm: 'auto', argocd: 'auto', flux: 'auto', contexts: ['*'], namespaces: ['*'],
    writes: [], maxReplicas: 10,
    rules: [], deniedPaths: [] };
}
export function defaultSettings(): AiSettings {
  return { providers: [], defaultProvider: null, defaultModel: null, options: {}, policy: defaultPolicy(), instructions: '' };
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
