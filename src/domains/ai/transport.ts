import { diagnosticInvoke } from '../../providers/diagnostic_invoke';
import type { ToolCall, AgentEvent, AgentMode, AgentPhase, AgentScope, AiSettings, AutoConfigureResult, ClusterCapabilities, GenerationOptions, McpHttpStatus, ModelInfo, SessionView, SettingsView } from './types';
import { OpenCodeNotStartedError } from '../../providers/tauri_exec';

export function desktopAiAvailable(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; }
export function agentError(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : 'The AI request failed. Check the connection and settings.';
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktopAiAvailable()) throw new Error('AI connections and cluster tools are available in the desktop app.');
  const invoke = diagnosticInvoke;
  return invoke<T>(command, args);
}
export const agentTransport = {
  testProvider: (profile: import('./types').ProviderProfile, apiKey?: string) => invoke<ModelInfo[]>('ai_test_provider', { profile, apiKey: apiKey || null }),
  skills: () => invoke<import('./types').SkillInfo[]>('ai_list_skills'),
  testExternalAgent: (runtime: import('./types').AgentRuntime, settings: import('./types').OpenCodeSettings) => invoke<{executable:string;version:string}>('ai_test_external_agent', {runtime, settings}),
  testOpenCode: (settings: import('./types').OpenCodeSettings) => invoke<{executable:string;version:string}>('ai_test_opencode', {settings}),
  detectSystemTerminal: (overrideExecutable?: string) => invoke<{ label: string; executable: string }>('ai_detect_system_terminal', { overrideExecutable: overrideExecutable || null }),
  async startExternalAgentSystemTerminal(sessionId: string, request: { scope: AgentScope; prompt: string | null }): Promise<{ sessionId: string; terminal: string }> {
    try {
      return await invoke<{ sessionId: string; terminal: string }>('start_external_agent_system_terminal', { sessionId, request });
    } catch (error) {
      if (error && typeof error === 'object'
        && 'code' in error && error.code === 'opencode_start_failed'
        && 'processStarted' in error && error.processStarted === false
        && 'message' in error && typeof error.message === 'string') {
        throw new OpenCodeNotStartedError(error.message);
      }
      throw error;
    }
  },
  stopExternalAgentSystemTerminal: (sessionId: string) => invoke<void>('stop_external_agent_system_terminal', { sessionId }),
  mcpHttpStatus: (revealToken?: boolean) => invoke<McpHttpStatus>('ai_mcp_http_status', { revealToken: Boolean(revealToken) }),
  mcpHttpRegenerateToken: () => invoke<McpHttpStatus>('ai_mcp_http_regenerate_token'),
  mcpSetScope: (scope: AgentScope) => invoke<void>('ai_mcp_set_scope', { scope }),
  mcpAutoConfigure: (client: 'opencode' | 'claude' | 'cursor') => invoke<AutoConfigureResult>('ai_mcp_auto_configure', { client }),
  evidence: (sessionId:string,evidenceId:string) => invoke<{data:Record<string,unknown>;warning:string}>('ai_get_evidence',{sessionId,evidenceId}),
  previewPolicy: (request: { policy: AiSettings['policy']; scope: AgentScope; target: {group:string;version:string;kind:string;namespace:string|null;name:string}; mode:AgentMode;phase:AgentPhase;operation?:string }) => invoke<{explanation:{allowed:boolean;explanation:string;dataAccess:string;writeAllowed:boolean};issues:Array<{ruleIndex:number;kind:string;message:string}>}>('ai_preview_policy', { request }),
  reviewPlan: (sessionId:string,planId:string,version:number,stepIds:string[]) => invoke<{reviewToken:string;plan:import('./types').PlanArtifact;steps:Array<{stepId:string;target:{kind:string;namespace:string|null;name:string};operation:string;call:ToolCall}>}>('ai_review_plan',{request:{sessionId,planId,version,stepIds}}),
  async executePlan(sessionId:string,reviewToken:string,receive:(event:AgentEvent)=>void) {
    const { Channel } = await import('@tauri-apps/api/core'); const invoke = diagnosticInvoke;const onEvent=new Channel<AgentEvent>();onEvent.onmessage=receive;
    try{return await invoke<Record<string,unknown>>('ai_execute_plan',{request:{sessionId,reviewToken},onEvent});}
    finally {onEvent.onmessage=()=>{};const w=window as unknown as {__TAURI_INTERNALS__?:{unregisterCallback?:(id:number)=>void}};w.__TAURI_INTERNALS__?.unregisterCallback?.(onEvent.id);}
  },
  settings: () => invoke<SettingsView>('ai_get_settings'),
  save: (settings: AiSettings) => invoke<void>('ai_save_settings', { settings }),
  credential: (providerId: string, apiKey: string | null) => invoke<void>('ai_set_credential', { providerId, apiKey }),
  models: (providerId: string, modelId?: string) => invoke<ModelInfo[]>('ai_list_models', { providerId, modelId }),
  create: (scope: AgentScope, providerId: string, model: string, options: GenerationOptions, capabilities?: ClusterCapabilities, intent?: 'chat'|'investigate'|'create') => invoke<SessionView>('ai_create_session', { request: { scope, providerId, model, options, capabilities, intent } }),
  mode: (sessionId: string, mode: AgentMode) => invoke<SessionView>('ai_set_mode', { sessionId, mode }),
  phase: (sessionId: string, phase: AgentPhase) => invoke<SessionView>('ai_set_phase', { sessionId, phase }),
  stop: (sessionId: string, close = false) => invoke<void>('ai_stop', { sessionId, close }),
  async send(sessionId: string, message: string, receive: (event: AgentEvent) => void): Promise<void> {
    if (!desktopAiAvailable()) throw new Error('Open the desktop app to send AI messages.');
    const { Channel } = await import('@tauri-apps/api/core'); const invoke = diagnosticInvoke;
    const onEvent = new Channel<AgentEvent>();
    let text = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; if (text) { const value = text; text = ''; receive({ type: 'text_delta', text: value }); } };
    onEvent.onmessage = event => {
      if (event.type === 'text_delta') { text += event.text; timer ??= setTimeout(flush, 32); }
      else { flush(); receive(event); }
    };
    try { await invoke('ai_send_message', { sessionId, message, onEvent }); }
    finally {
      flush();
      onEvent.onmessage = () => {};
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__;
      internals?.unregisterCallback?.(onEvent.id);
    }
  },
};
