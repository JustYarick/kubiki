export interface ToolIntentInfo {
  title: string;
  description: string;
  destructive?: boolean;
  badge: string;
  color: 'emerald' | 'amber' | 'rose' | 'sky' | 'indigo' | 'purple' | 'blue' | 'slate';
}

export function getToolIntent(name: string, args: Record<string, any> = {}): ToolIntentInfo {
  switch (name) {
    case 'scale_workload': {
      const kind = args.kind || 'Workload';
      const resourceName = args.name ? `"${args.name}"` : '';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      const count = args.replicas ?? '?';
      return {
        title: `Scale ${kind} ${resourceName}${ns} to ${count} replicas`,
        description: `Modifies the spec.replicas field on the Kubernetes cluster. The workload controller will automatically reconcile running Pod instances to match this target.`,
        badge: 'SCALE',
        color: 'sky',
      };
    }
    case 'restart_workload': {
      const kind = args.kind || 'Workload';
      const resourceName = args.name ? `"${args.name}"` : '';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Restart ${kind} ${resourceName}${ns}`,
        description: `Triggers a rolling restart by updating the pod template timestamp annotation. Kubernetes creates new pods before terminating old ones to ensure zero downtime.`,
        badge: 'RESTART',
        color: 'amber',
      };
    }
    case 'delete_resource': {
      const kind = args.kind || 'Resource';
      const resourceName = args.name ? `"${args.name}"` : '';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Delete ${kind} ${resourceName}${ns}`,
        description: `Destructive operation: permanently removes the resource from the cluster with version concurrency checks (resourceVersion). Dependent resources may be cascaded.`,
        destructive: true,
        badge: 'DELETE',
        color: 'rose',
      };
    }
    case 'apply_manifest': {
      let kind = 'Resource';
      let resourceName = '';
      let ns = '';
      try {
        if (args.yaml) {
          const matchKind = String(args.yaml).match(/kind:\s*([A-Za-z0-9_-]+)/);
          const matchName = String(args.yaml).match(/name:\s*([A-Za-z0-9_.-]+)/);
          const matchNs = String(args.yaml).match(/namespace:\s*([A-Za-z0-9_.-]+)/);
          if (matchKind) kind = matchKind[1];
          if (matchName) resourceName = ` "${matchName[1]}"`;
          if (matchNs) ns = ` in namespace "${matchNs[1]}"`;
        }
      } catch {}
      return {
        title: `Apply YAML manifest for ${kind}${resourceName}${ns}`,
        description: `Sends declarative YAML to the Kubernetes API server using Server-Side Apply. If the object does not exist, it creates it; otherwise it safely updates its configuration.`,
        badge: 'APPLY',
        color: 'emerald',
      };
    }
    case 'propose_manifests': {
      return {
        title: `Propose YAML manifest: ${args.title || 'Resources'}`,
        description: `Generates Kubernetes YAML resources as a review proposal without executing them on the cluster. You can inspect, copy, or instruct the agent to apply it.`,
        badge: 'PROPOSAL',
        color: 'emerald',
      };
    }
    case 'ask_user': {
      return {
        title: args.question || 'Agent Question',
        description: `The AI agent needs your clarification to proceed with the task. Choose one of the suggested options or type a custom response.`,
        badge: 'QUESTION',
        color: 'indigo',
      };
    }
    case 'list_helm_releases': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : ' (all namespaces)';
      return {
        title: `List Helm releases${ns}`,
        description: `Discovers installed Helm chart releases, release status (deployed, failed, pending), revisions, and chart versions.`,
        badge: 'HELM',
        color: 'sky',
      };
    }
    case 'get_helm_release': {
      return {
        title: `Inspect Helm release "${args.name || ''}" in "${args.namespace || ''}"`,
        description: `Reads user-supplied values.yaml and revision history for the specified Helm release to diagnose misconfigurations.`,
        badge: 'HELM',
        color: 'sky',
      };
    }
    case 'list_argocd_apps': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `List Argo CD Applications${ns}`,
        description: `Lists Argo CD GitOps applications with health status (Healthy, Degraded), sync status (Synced, OutOfSync), and target repos.`,
        badge: 'ARGOCD',
        color: 'amber',
      };
    }
    case 'get_argocd_app': {
      return {
        title: `Inspect Argo CD Application "${args.name || ''}"`,
        description: `Retrieves deep sync status, health conditions, source repository, and managed resource tree for the Argo CD application.`,
        badge: 'ARGOCD',
        color: 'amber',
      };
    }
    case 'sync_argocd_app': {
      return {
        title: `Sync / Refresh Argo CD Application "${args.name || ''}"`,
        description: `Triggers an Argo CD application sync or hard refresh against the Git repository to reconcile desired state.`,
        destructive: false,
        badge: 'ARGO SYNC',
        color: 'amber',
      };
    }
    case 'list_flux_resources': {
      const kind = args.kind ? `${args.kind}s` : 'GitOps resources';
      const ns = args.namespace ? ` in "${args.namespace}"` : '';
      return {
        title: `List Flux ${kind}${ns}`,
        description: `Discovers Flux delivery and source resources (Kustomizations, HelmReleases, GitRepositories) and their Ready conditions.`,
        badge: 'FLUX',
        color: 'indigo',
      };
    }
    case 'get_flux_resource': {
      return {
        title: `Inspect Flux ${args.kind || 'resource'} "${args.name || ''}"`,
        description: `Inspects detailed status conditions, error messages, last applied revision, and inventory for the Flux delivery resource.`,
        badge: 'FLUX',
        color: 'indigo',
      };
    }
    case 'reconcile_flux_resource': {
      return {
        title: `Reconcile Flux ${args.kind || 'resource'} "${args.name || ''}"`,
        description: `Requests an immediate Flux reconciliation by setting reconcile.fluxcd.io/requestedAt annotation to sync with Git/Helm repository.`,
        destructive: false,
        badge: 'RECONCILE',
        color: 'indigo',
      };
    }
    case 'get_pod_diagnostics': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Deep diagnostics for Pod "${args.name || ''}"${ns}`,
        description: `Analyzes termination exit codes, OOMKilled events, CrashLoopBackOff waiting states, probe health, and scheduling conditions.`,
        badge: 'POD DIAG',
        color: 'purple',
      };
    }
    case 'get_workload_diagnostics': {
      const kind = args.kind || 'Workload';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Rollout & replica diagnostics for ${kind} "${args.name || ''}"${ns}`,
        description: `Inspects rollout progression, desired vs ready replicas, condition failures, and child ReplicaSets/Pods.`,
        badge: 'WORKLOAD',
        color: 'indigo',
      };
    }
    case 'get_events_timeline': {
      const target = args.name ? ` for "${args.name}"` : args.namespace ? ` in "${args.namespace}"` : '';
      return {
        title: `Chronological events timeline${target}`,
        description: `Builds a structured, deduplicated timeline of Warning and Normal events with occurrence counts and timestamps.`,
        badge: 'TIMELINE',
        color: 'amber',
      };
    }
    case 'get_logs': {
      const container = args.container ? ` container "${args.container}"` : '';
      const pod = args.name ? ` in Pod "${args.name}"` : '';
      return {
        title: `Read logs for${container}${pod}`,
        description: `Retrieves a bounded slice of container runtime logs from Kubernetes for diagnostics and error analysis.`,
        badge: 'LOGS',
        color: 'blue',
      };
    }
    case 'get_events': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      const name = args.name ? ` for "${args.name}"` : '';
      return {
        title: `Inspect cluster events${name}${ns}`,
        description: `Reads recent Kubernetes events (scheduling warnings, volume failures, OOMKilled, BackOffs) to diagnose workload health.`,
        badge: 'EVENTS',
        color: 'purple',
      };
    }
    case 'get_resource': {
      const target = `${args.kind || 'Resource'} "${args.name || ''}"`;
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Read ${target}${ns}`,
        description: `Fetches resource configuration and live status from the Kubernetes API through data access and redaction policy.`,
        badge: 'GET',
        color: 'slate',
      };
    }
    case 'list_resources': {
      const kind = args.kind || 'resources';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : ' (cluster-wide)';
      return {
        title: `List ${kind}${ns}`,
        description: `Discovers live instances of ${kind} within the specified scope, capped at 50 items.`,
        badge: 'LIST',
        color: 'slate',
      };
    }
    case 'list_namespaces': {
      return {
        title: 'Discover permitted namespaces',
        description: `Lists accessible namespace names in the connected cluster context under current RBAC and conversation scope.`,
        badge: 'DISCOVERY',
        color: 'slate',
      };
    }
    default: {
      return {
        title: `Execute ${name}`,
        description: `Cluster inspection or diagnostic operation executed under the conversation access policy.`,
        badge: name.toUpperCase().slice(0, 10),
        color: 'slate',
      };
    }
  }
}

export function getToolCallSummary(name: string, args: Record<string, any> = {}, result?: Record<string, any>): string {
  if (!result) return 'Executing…';
  if (result.error && typeof result.error === 'string') return `Failed: ${result.error}`;

  switch (name) {
    case 'list_helm_releases': {
      const releases = Array.isArray(result.releases) ? result.releases : [];
      const deployed = releases.filter((r: any) => r.status === 'deployed').length;
      const issues = releases.length - deployed;
      return `${releases.length} release${releases.length === 1 ? '' : 's'} found${issues > 0 ? ` (${issues} with issues)` : ' (all deployed)'}`;
    }
    case 'get_helm_release': {
      const rel = result.release;
      if (rel) {
        return `Chart ${rel.chart || ''} · v${rel.app_version || ''} (status: ${rel.status || 'unknown'})`;
      }
      return 'Release details retrieved';
    }
    case 'list_resources': {
      const items = Array.isArray(result.items) ? result.items : [];
      const kind = args.kind || 'resource';
      return `${items.length} ${kind}${items.length === 1 ? '' : 's'} inspected${result.hasMore ? ' (capped at 50)' : ''}`;
    }
    case 'get_resource': {
      const kind = args.kind || 'Resource';
      const name = args.name || '';
      return `${kind} "${name}" retrieved`;
    }
    case 'list_namespaces': {
      const nss = Array.isArray(result.namespaces) ? result.namespaces : Array.isArray(result.items) ? result.items : [];
      return `${nss.length} namespace${nss.length === 1 ? '' : 's'} discovered`;
    }
    case 'list_argocd_apps': {
      const apps = Array.isArray(result.applications) ? result.applications : [];
      const healthy = apps.filter((a: any) => a.health === 'Healthy').length;
      return `${apps.length} application${apps.length === 1 ? '' : 's'} discovered (${healthy} healthy)`;
    }
    case 'get_argocd_app': {
      return `Application "${args.name || ''}" status retrieved`;
    }
    case 'list_flux_resources': {
      const res = Array.isArray(result.resources) ? result.resources : [];
      const ready = res.filter((r: any) => r.ready === 'True').length;
      return `${res.length} resource${res.length === 1 ? '' : 's'} discovered (${ready} ready)`;
    }
    case 'get_flux_resource': {
      return `Flux ${args.kind || 'resource'} "${args.name || ''}" inspected`;
    }
    case 'get_pod_diagnostics': {
      const issues = Array.isArray(result.issuesSummary) ? result.issuesSummary.length : 0;
      return issues > 0 ? `Diagnostics complete · ${issues} issue(s) detected` : 'Diagnostics complete · Healthy';
    }
    case 'get_workload_diagnostics': {
      const state = result.rolloutState || 'healthy';
      const issues = Array.isArray(result.issuesSummary) ? result.issuesSummary.length : 0;
      return `Rollout ${state}${issues > 0 ? ` · ${issues} issue(s)` : ''}`;
    }
    case 'get_events_timeline': {
      const events = Array.isArray(result.timeline) ? result.timeline : [];
      return `${events.length} event${events.length === 1 ? '' : 's'} recorded in timeline`;
    }
    case 'get_events': {
      const events = Array.isArray(result.events) ? result.events : [];
      return `${events.length} event${events.length === 1 ? '' : 's'} retrieved`;
    }
    case 'get_logs': {
      const lines = typeof result.logs === 'string' ? result.logs.split('\n').filter(Boolean).length : 0;
      return `Fetched ${lines} log line${lines === 1 ? '' : 's'}`;
    }
    case 'scale_workload': {
      return `Scaled to ${args.replicas ?? '?'} replicas`;
    }
    case 'restart_workload': {
      return `Rolling restart triggered`;
    }
    case 'delete_resource': {
      return `Resource deleted`;
    }
    case 'apply_manifest': {
      return `Manifest applied${result.operationId ? ` (Receipt: ${result.operationId})` : ''}`;
    }
    default: {
      if (typeof result.status === 'string') return result.status;
      return 'Complete';
    }
  }
}

/**
 * Detects whether an assistant message represents a structured action plan.
 * Recognizes English and Russian markdown headings, labeled plan sections,
 * and conversational context where the user explicitly requested a plan.
 */
export function isPlanMessage(text: string, userPrompt?: string): boolean {
  if (!text) return false;
  // 1. Any markdown heading containing Plan or План or remediation steps
  if (/(?:^|\n)#+\s*.*(?:plan|план|шаги\s+(?:по\s+)?(?:устранению|исправлению|решению)|steps\s+to|action\s+items)/i.test(text)) {
    return true;
  }
  // 2. Bold or labeled line starting with Plan / План
  if (/(?:^|\n)(?:\*\*)?(?:action\s+plan|proposed\s+plan|strategic\s+plan|plan|пошаговый\s+план|план(?:\s+действий|\s+решения|\s+работ)?)(?:\*\*)?\s*[:—\-]/i.test(text)) {
    return true;
  }
  // 3. User explicitly requested a plan in their prompt and response contains numbered steps or bullet lists
  if (userPrompt && /(?:^|\s)(?:\/plan\b|plan\b|план|составь\s+план|сделай\s+план|(?:сделай|составь|напиши|дай|предложи|разработай|нужен|make|create|write|give|propose|draft|need|provide)\s+.*(?:план|plan))/i.test(userPrompt)) {
    if (/(?:^|\n)\s*(?:\d+[\.\)]|\-|\*)\s+/.test(text)) {
      return true;
    }
  }
  return false;
}

