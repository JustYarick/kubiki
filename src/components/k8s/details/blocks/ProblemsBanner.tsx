import { AlertCircle, AlertTriangle, Bot, HelpCircle } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { AI_AGENTS, ANALYSIS_INSTRUCTIONS, buildAnalysisPrompt } from '../../../../core/ai_analysis';
import { useClusterStore } from '../../../../state/cluster_store';
import { useResourceStore } from '../../../../state/resource_store';
import { useWorkspaceStore } from '../../../../state/workspace_store';
import { useUiStore } from '../../../../state/ui_store';
import type { ResourceItem } from '../../../../types/k8s';
import { resourceIssues } from '../../../../core/resources/diagnostics';
import { cx } from '../../../../core/utils/cx';

interface ProblemsBannerProps {
  item: ResourceItem;
  className?: string;
}

interface Diagnosis {
  title: string;
  explanation: string;
  actionHint: string;
  severity: 'error' | 'warning';
}

export function ProblemsBanner({ item, className }: ProblemsBannerProps) {
  const agent = useUiStore(state => state.aiAgent);
  const defaultPrompt = useUiStore(state => state.aiAnalysisPrompt === ANALYSIS_INSTRUCTIONS);
  const issues = resourceIssues(item);
  const raw = item.raw ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const metadata = raw.metadata ?? item.metadata ?? {};

  const diagnoses: Diagnosis[] = [];

  // 1. Check Pod Container states
  if (item.kind === 'Pod') {
    const containerStatuses: any[] = [
      ...(status.containerStatuses ?? []),
      ...(status.initContainerStatuses ?? []),
      ...(status.ephemeralContainerStatuses ?? []),
    ];

    for (const cs of containerStatuses) {
      const waiting = cs.state?.waiting;
      const terminated = cs.state?.terminated;
      const lastTerminated = cs.lastState?.terminated;

      // OOMKilled detection
      if (terminated?.reason === 'OOMKilled' || terminated?.exitCode === 137 || (!cs.ready && (lastTerminated?.reason === 'OOMKilled' || lastTerminated?.exitCode === 137))) {
        diagnoses.push({
          severity: 'error',
          title: `OOMKilled (Exit Code 137) · Container "${cs.name}"`,
          explanation: `The process was killed by Linux OOM killer because memory consumption exceeded the defined container limit.`,
          actionHint: `Increase "resources.limits.memory" in your Pod/Deployment spec or investigate memory leaks in the application.`,
        });
      }

      // CrashLoopBackOff
      if (waiting?.reason === 'CrashLoopBackOff') {
        const exit = lastTerminated?.exitCode !== undefined ? ` (Exit code ${lastTerminated.exitCode})` : '';
        const reason = lastTerminated?.reason ? ` [${lastTerminated.reason}]` : '';
        diagnoses.push({
          severity: 'error',
          title: `CrashLoopBackOff · Container "${cs.name}"${exit}`,
          explanation: `Container starts and immediately crashes or exits${reason}. Restarts count: ${cs.restartCount || 0}.`,
          actionHint: `Check previous instance logs ("Previous" toggle in Logs) or container command/entrypoint and environment variables.`,
        });
      }

      // ImagePullBackOff / ErrImagePull
      if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
        diagnoses.push({
          severity: 'error',
          title: `ImagePullBackOff · Container "${cs.name}"`,
          explanation: waiting.message || `Kubelet cannot pull image "${cs.image}". Image may not exist or repository requires authentication.`,
          actionHint: `Verify image name and tag. Ensure "imagePullSecrets" are specified in Pod spec or ServiceAccount for private registries.`,
        });
      }

      // CreateContainerConfigError / CreateContainerError
      if (waiting?.reason === 'CreateContainerConfigError' || waiting?.reason === 'CreateContainerError') {
        diagnoses.push({
          severity: 'error',
          title: `Configuration Error · Container "${cs.name}"`,
          explanation: waiting.message || `Cannot create container. A referenced Secret or ConfigMap may be missing.`,
          actionHint: `Inspect environment variables and volume mounts to ensure all referenced ConfigMaps and Secrets exist in namespace "${item.namespace}".`,
        });
      }
    }

    // Unschedulable / FailedScheduling
    const podScheduled = (status.conditions ?? []).find((c: any) => c.type === 'PodScheduled');
    if (podScheduled?.status === 'False' && podScheduled.reason === 'Unschedulable') {
      diagnoses.push({
        severity: 'warning',
        title: `Unschedulable · Cannot place Pod on any Node`,
        explanation: podScheduled.message || `0 nodes available matching resource requirements or constraints.`,
        actionHint: `Check whether cluster nodes have sufficient CPU/RAM, or if the Pod has taints/tolerations or nodeSelector constraints that no node matches.`,
      });
    }
  }

  // 2. Service without endpoints
  if (item.kind === 'Service') {
    const selector = raw.spec?.selector;
    if (selector && Object.keys(selector).length > 0 && item.ready === '0/0') {
      diagnoses.push({
        severity: 'warning',
        title: `No Endpoints · Service Selector Has No Matching Pods`,
        explanation: `Service defines selector ${JSON.stringify(selector)}, but no running Pods in namespace "${item.namespace}" match these labels.`,
        actionHint: `Verify labels on your workload's Pod template match the Service selector exactly.`,
      });
    }
  }

  // 3. Resource stuck in Terminating with finalizers
  if (metadata.deletionTimestamp) {
    const finalizers: string[] = metadata.finalizers ?? [];
    if (finalizers.length > 0) {
      diagnoses.push({
        severity: 'warning',
        title: `Deletion In Progress · Blocked by Finalizers`,
        explanation: `Resource cannot be removed until controllers clean up: [${finalizers.join(', ')}].`,
        actionHint: `If the controller or operator is no longer running, you can manually remove finalizers in the Metadata block.`,
      });
    }
  }

  // 4. Ingress missing backend
  if (item.kind === 'Ingress') {
    const rules = raw.spec?.rules ?? [];
    let hasBackendIssue = false;
    for (const r of rules) {
      for (const p of r.http?.paths ?? []) {
        if (!p.backend?.service?.name) {
          hasBackendIssue = true;
          break;
        }
      }
    }
    if (hasBackendIssue) {
      diagnoses.push({
        severity: 'warning',
        title: `Incomplete Ingress Rule Backend`,
        explanation: `One or more path rules do not have a defined target Service backend.`,
        actionHint: `Edit Ingress YAML and specify backend.service.name and backend.service.port.`,
      });
    }
  }

  // 5. Fallback from generic diagnostics if no specific diagnoses found
  if (diagnoses.length === 0 && issues.length > 0) {
    for (const iss of issues) {
      diagnoses.push({
        severity: iss.severity,
        title: iss.summary,
        explanation: iss.message || iss.summary,
        actionHint: `Inspect events and resource conditions below for additional details.`,
      });
    }
  }

  // If everything is healthy, do NOT display the banner!
  if (diagnoses.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="problems-banner"
      className={cx(
        'rounded-lg border p-3 flex flex-col gap-2.5 transition-all select-text shadow-sm',
        diagnoses.some((d) => d.severity === 'error')
          ? 'bg-rose-950/20 border-rose-500/40 text-rose-200'
          : 'bg-amber-950/20 border-amber-500/40 text-amber-200',
        className
      )}
    >
      <div className="flex items-center gap-2 font-semibold text-xs tracking-wide uppercase">
        {diagnoses.some((d) => d.severity === 'error') ? (
          <AlertCircle size="calc(15px * var(--ui-factor))" className="text-rose-400 shrink-0" />
        ) : (
          <AlertTriangle size="calc(15px * var(--ui-factor))" className="text-amber-400 shrink-0" />
        )}
        <span>What's wrong · {diagnoses.length} {diagnoses.length === 1 ? 'issue' : 'issues'} detected</span>
      </div>

      <div className="flex flex-col gap-2">
        {diagnoses.map((diag, index) => (
          <div key={index} className="flex flex-col gap-1 border-t border-white/5 pt-2 first:border-0 first:pt-0">
            <div className="text-xs font-semibold text-[var(--text-primary)]">
              {diag.title}
            </div>
            <p className="text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-secondary)] leading-relaxed">
              {diag.explanation}
            </p>
            <div className="flex items-start gap-1.5 mt-0.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--accent)] font-medium bg-[var(--accent-subtle)]/30 rounded px-2 py-1">
              <HelpCircle size="calc(13px * var(--ui-factor))" className="shrink-0 mt-0.5 opacity-80" />
              <span>{diag.actionHint}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
        <Button variant="danger" size="sm" onClick={() => {
          const context = useClusterStore.getState().currentContext;
          const prompt = buildAnalysisPrompt(item, context, useResourceStore.getState().resources.Event.values(), diagnoses, useUiStore.getState().aiAnalysisPrompt);
          useWorkspaceStore.getState().openTerminalSession({ id: `analysis-${crypto.randomUUID()}`, type: 'terminal', title: `Analyze: ${item.name}`, targetType: 'local', analysis: { agent, prompt } });
          useUiStore.setState({ inspectorCollapsed: true });
        }}><Bot size={14} aria-hidden="true" />Analyze</Button>
        <span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)]">{AI_AGENTS.find(entry => entry.id === agent)?.label} · {defaultPrompt ? 'analysis only' : 'custom prompt'}</span>
      </div>
    </div>
  );
}
