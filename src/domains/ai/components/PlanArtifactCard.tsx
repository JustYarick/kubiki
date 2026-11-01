import { useEffect, useState } from 'react';
import { Check, Code, Copy, Download, FileText } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../../components/ui/Button';
import { CodeEditor } from '../../../components/ui/CodeEditor';
import { toast } from '../../../state/notifications_store';
import { applyAgentEvent, useAiStore } from '../store';
import { downloadMarkdown, planMarkdown } from '../chat_artifacts';
import { historyPreferences, flushAiHistory } from '../history_storage';
import { agentTransport } from '../transport';
import type { Conversation, PlanArtifact } from '../types';

export function PlanArtifactCard({ artifact, conversation: c }: { artifact: PlanArtifact; conversation: Conversation }) {
  const sameSession = c.sessionId === artifact.sessionId;
  const [evidence, setEvidence] = useState<{ data: Record<string, unknown>; warning: string } | undefined>();
  const [selected, setSelected] = useState(artifact.steps.filter(s => !['inspect', 'manual'].includes(s.action)).map(s => s.id));
  const [review, setReview] = useState<Awaited<ReturnType<typeof agentTransport.reviewPlan>> | undefined>();
  const [operationError, setOperationError] = useState('');
  useEffect(() => { setReview(undefined); }, [artifact.id, artifact.version, c.mode, c.phase, c.sessionId]);
  const updateFromEvent = (event: import('../types').AgentEvent) => useAiStore.setState(state => ({ conversations: state.conversations.map(conv => conv.id === c.id ? applyAgentEvent(conv, event) : conv) }));
  const reviewSelected = async () => { if (!c.sessionId || !sameSession) return; setOperationError(''); useAiStore.getState().update(c.id, { busy: true, status: 'reviewing' }); try { const next = await agentTransport.reviewPlan(c.sessionId, artifact.id, artifact.version, selected); setReview(next); updateFromEvent({ type: 'plan_updated', plan: next.plan }); } catch (e) { setOperationError(String(e)); } finally { useAiStore.getState().update(c.id, { busy: false, status: 'idle' }); } };
  const executeReviewed = async () => { if (!review || !c.sessionId || !sameSession) return; const token = review.reviewToken; setReview(undefined); setOperationError(''); useAiStore.getState().update(c.id, { busy: true, status: 'executing' }); try { await agentTransport.executePlan(c.sessionId, token, updateFromEvent); } catch (e) { setOperationError(String(e)); } finally { useAiStore.getState().update(c.id, { busy: false }); await flushAiHistory(); } };
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(planMarkdown(artifact)).catch(() => toast.error('Clipboard unavailable'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => {
    if (!historyPreferences.allowExport) { toast.error('Export is disabled in history settings'); return; }
    downloadMarkdown(artifact.title, planMarkdown(artifact));
    toast.success('Plan exported to Markdown');
  };

  return (
    <article className="ai-plan-artifact-card" aria-label={`${artifact.kind === 'investigation' ? 'Investigation outline' : artifact.kind === 'deployment' ? 'Deployment plan' : 'Remediation plan'}: ${artifact.title}`}>
      <div className="ai-plan-header">
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-emerald-400" aria-hidden="true" />
          <span className="font-semibold text-sm text-[var(--text-primary)]">{artifact.title}</span>
          <span className="ai-plan-version-badge">v{artifact.version}</span>
          <span className={`ai-plan-status-badge is-${artifact.status || 'draft'}`}>
            {artifact.status?.toUpperCase() || 'DRAFT'}
          </span>
          {artifact.targetScope && (
            <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono">
              {artifact.targetScope}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setShowSource(!showSource)} title="Toggle Markdown Source">
            <Code size={12} aria-hidden="true" />
            <span className="text-[10.5px]">{showSource ? 'Preview' : 'Source'}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy Plan Markdown">
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            <span className="text-[10.5px]">{copied ? 'Copied!' : 'Copy'}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExport} title="Export to .md">
            <Download size={12} />
            <span className="text-[10.5px]">Export</span>
          </Button>
        </div>
      </div>

      <div className="ai-plan-body">
        <p className="p-2 text-sm"><strong>Diagnosis:</strong> {artifact.diagnosis}</p>
        <p className="p-2 text-xs"><strong>Uncertainty:</strong> {artifact.uncertainty || 'None stated; verify evidence before changes.'}</p>
        <ol className="p-3 list-decimal list-inside space-y-3">{artifact.steps.map(step => <li key={step.id}><strong>{step.title}</strong><p>{step.reason}</p><p className="text-xs">Risk: {step.risk}</p><p className="text-xs">Verify: {step.verification}</p><p className="text-xs">Requires verified: {step.dependsOn?.join(', ') || 'none'} · Requires API acceptance only: {step.dependsOnAccepted?.join(', ') || 'none'}</p>{step.target && <code>{step.target.kind} {step.target.namespace}/{step.target.name}</code>}</li>)}</ol>
        {showSource ? (
          <pre className="p-3 bg-[var(--bg-tertiary)] rounded text-xs font-mono overflow-auto max-h-[400px]">
            {artifact.bodyMarkdown}
          </pre>
        ) : (
          <div className="ai-markdown p-2">
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
              components={{
                img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
                pre: ({ children }) => <pre className="overflow-auto whitespace-pre-wrap">{children}</pre>,
              }}
            >
              {artifact.bodyMarkdown}
            </Markdown>
          </div>
        )}
      </div>

      {artifact.evidenceIds && artifact.evidenceIds.length > 0 && (
        <div className="ai-plan-evidence-section">
          <span className="text-[10.5px] font-medium text-[var(--text-secondary)]">Supporting Evidence:</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {artifact.evidenceIds.map(id => (
              <Button key={id} size="sm" disabled={!sameSession || c.invalidated} onClick={() => { if (c.sessionId) void agentTransport.evidence(c.sessionId, id).then(setEvidence).catch(e => setOperationError(String(e))); }}>#{id}</Button>
            ))}
          </div>
        </div>
      )}

      {evidence && <details open className="p-3"><summary>Referenced historical evidence</summary><p className="text-xs">{evidence.warning}</p><CodeEditor ariaLabel="Referenced evidence" value={JSON.stringify(evidence.data, null, 2)} language="json" readOnly height="240px" variant="field" /></details>}
      {artifact.steps.some(s => !['inspect', 'manual'].includes(s.action)) && <div className="p-3 space-y-2">
        {artifact.steps.filter(s => !['inspect', 'manual'].includes(s.action)).map(step => <label key={step.id} className="flex gap-2 text-xs"><input type="checkbox" aria-label={`Select plan step ${step.title}`} disabled={c.busy} checked={selected.includes(step.id)} onChange={e => { setSelected(e.target.checked ? [...selected, step.id] : selected.filter(id => id !== step.id)); setReview(undefined); }} />{step.title} · {step.action}</label>)}
        {review && <section aria-label="Plan execution review" className="space-y-3">{review.steps.map(step => <div key={step.stepId}><strong>{step.operation}: {step.target.kind} {step.target.namespace}/{step.target.name}</strong>{typeof step.call.arguments.yaml === 'string' ? <CodeEditor ariaLabel={`Reviewed YAML ${step.target.name}`} value={step.call.arguments.yaml} language="yaml" readOnly height="220px" variant="field" /> : <p className="text-xs">{step.call.name === 'scale_workload' ? `Set replicas to ${step.call.arguments.replicas}` : step.call.name === 'restart_workload' ? 'Request rollout restart' : 'Delete this exact resource'}</p>}<p className="text-xs">The review pins current identity and version. A concurrent change requires a new review. Ask also shows the native change preview before dispatch.</p></div>)}</section>}
        <Button size="sm" disabled={!sameSession || c.busy || c.invalidated || c.mode === 'read_only' || c.phase === 'plan' || !selected.length || !['draft', 'ready'].includes(artifact.status ?? 'draft')} onClick={() => void reviewSelected()}>Review selected steps</Button>
        {review && <Button size="sm" variant="primary" disabled={!sameSession || c.busy || c.invalidated || c.phase === 'plan' || c.mode === 'read_only'} onClick={() => void executeReviewed()}>Execute reviewed steps</Button>}
        <p className="text-xs">Execution requires Ask or Accept and Action. Each reviewed version is single-use; API acceptance and application health are separate.</p>
        {operationError && <p role="alert">{operationError}</p>}
      </div>}
      <div className="ai-plan-action-bar">
        <Button size="sm" disabled={c.busy || c.invalidated} onClick={() => useAiStore.getState().update(c.id, { draft: sameSession ? `Refresh permitted evidence and revise plan ${artifact.id} using planId. Preserve the goal, update diagnosis, risks and verification.` : `Investigate ${artifact.title} using fresh permitted evidence and propose a new remediation plan. The previous proposal belongs to a historical session.` })}>Refresh and revise</Button>
        <Button size="sm" disabled={c.busy || c.invalidated} onClick={() => useAiStore.getState().update(c.id, { draft: `Clarify remediation plan ${artifact.id}: ` })}>Clarify</Button>
        <span className="text-xs text-[var(--text-secondary)]">
          {!sameSession || c.invalidated || artifact.status === 'stale'
            ? 'Historical proposal. Refresh evidence and rebuild before considering changes.'
            : 'Proposal only. Each change requires current scope, policy and separate authorization in Action.'}
        </span>
      </div>
    </article>
  );
}
