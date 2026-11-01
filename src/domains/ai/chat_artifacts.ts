import type { Conversation, PlanArtifact } from './types';
import { historyPreferences } from './history_storage';
export function planMarkdown(plan: PlanArtifact): string {
  const steps = plan.steps.map((step, index) => {
    const target = step.target ? `${step.target.kind} ${step.target.namespace || '(cluster)'}/${step.target.name} (${step.target.group || 'core'}/${step.target.version})` : 'Manual/read-only context';
    const lines = [`${index + 1}. **${step.title}** (${step.action})`, `   Target: ${target}`, `   ${step.reason}`, `   Risk: ${step.risk}`, `   Verification: ${step.verification}`, `   Requires verified: ${step.dependsOn?.join(', ') || 'none'}`, `   Requires API acceptance only: ${step.dependsOnAccepted?.join(', ') || 'none'}`];
    if (step.replicas != null) lines.push(`   Replicas: ${step.replicas}`);
    if (step.yaml) lines.push(`\n\`\`\`yaml\n${step.yaml}\n\`\`\``);
    return lines.join('\n');
  }).join('\n\n');
  return `# ${plan.title}\n\nPlan: ${plan.id} v${plan.version} (${plan.kind})\nScope: ${plan.scope.context} / ${plan.scope.namespaces.join(', ') || 'explicit queries'}\nRevision: ${plan.policyRevision ?? 'unknown'}\n\n## Diagnosis\n${plan.diagnosis}\n\n## Uncertainty\n${plan.uncertainty}\n\n## Steps\n${steps}\n\n## Evidence\n${plan.evidenceIds?.join(', ') || 'No evidence references'}\n\n${plan.bodyMarkdown}\n`;
}
export function transcriptMarkdown(conversation: Conversation): string {
  return `# ${conversation.title}\n\nHistorical transcript · ${conversation.scope.context || 'General chat'}\n\n` + conversation.messages.filter(m => m.role !== 'tool').map(m => `## ${m.role === 'user' ? 'You' : 'Agent'}\n\n${m.text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '')}`).join('\n\n');
}
export function downloadMarkdown(title: string, body: string) {
  if (!historyPreferences.allowExport) throw new Error('Export is disabled in history settings');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'conversation'}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
