import type { ChatMessage, Conversation } from './types';

/** Tool payloads are live evidence. Persist only their identity and durable receipt. */
export function persistedMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') return { ...message, planArtifact: undefined };
  const args = message.call?.arguments ?? {};
  const identity: Record<string, unknown> = {};
  for (const key of ['group', 'version', 'kind', 'namespace', 'name']) {
    if (typeof args[key] === 'string' || args[key] === null) identity[key] = args[key];
  }
  const result: Record<string, unknown> = { historical: true, payloadOmitted: true, message: 'Tool payload was not saved. Refresh permitted evidence or request the proposal again.' };
  if (typeof message.result?.operationId === 'string') {
    result.operationId = message.result.operationId;
    if (typeof message.result.status === 'string' && ['accepted', 'failed', 'cancelled', 'uncertain', 'dispatching'].includes(message.result.status)) result.status = message.result.status;
  }
  return { ...message, planArtifact: undefined, text: message.call?.name ?? 'Tool', call: message.call ? { ...message.call, arguments: identity } : undefined, result };
}

/** Upgrade old local history without restoring runs, approvals or tool bodies. */
export function migrateAiHistory(value: unknown): { conversations: Conversation[]; activeId: string | null } {
  const data = value && typeof value === 'object' ? value as { conversations?: unknown; activeId?: unknown } : {};
  const conversations = Array.isArray(data.conversations) ? data.conversations.filter(c => c && typeof c.id === 'string' && Array.isArray(c.messages)).map(c => ({
    ...c, activePlan: undefined, sessionId: undefined, mode: 'read_only', phase: 'plan', busy: false, status: 'idle', draft: '',
    messages: c.messages.filter((m: unknown) => m && typeof m === 'object' && typeof (m as ChatMessage).role === 'string' && typeof (m as ChatMessage).text === 'string').map(persistedMessage),
  } as Conversation)) : [];
  return { conversations, activeId: typeof data.activeId === 'string' && conversations.some(c => c.id === data.activeId) ? data.activeId : null };
}
