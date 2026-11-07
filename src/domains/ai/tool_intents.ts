export interface ToolIntentInfo {
  title: string;
  description: string;
  destructive?: boolean;
  badge: string;
  color: 'emerald' | 'amber' | 'rose' | 'sky' | 'indigo' | 'purple' | 'blue' | 'slate';
}

export function getToolIntent(name: string, args: Record<string, any> = {}): ToolIntentInfo {
  if (name.startsWith('mcp_')) return { title: 'Call MCP tool', description: 'Uses an explicitly connected external server.', badge: 'MCP', color: 'purple' };
  switch (name) {
    case 'run_command': return { title: `Run ${args.program ?? 'local command'}`, description: args.reason || 'Runs on this computer in the configured working directory.', badge: 'COMMAND', color: 'amber' };
    case 'read_skill': return { title: `Read skill $${args.name ?? ''}`, description: 'Loads installed skill instructions or a reference file.', badge: 'SKILL', color: 'indigo' };
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
    case 'diagnose_resource': {
      const kind = args.kind || 'Resource';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Diagnose ${kind} "${args.name || ''}"${ns}`,
        description: `Collects a comprehensive diagnostic bundle: workload/pod health, crash causes, bounded neighborhood graph, UID-bound events, and failing container logs.`,
        badge: 'DIAGNOSE',
        color: 'purple',
      };
    }
    case 'get_neighborhood': {
      const kind = args.kind || 'Resource';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Explore neighborhood graph for ${kind} "${args.name || ''}"${ns}`,
        description: `Traverses owner references, dependency links, and selector relationships around the target resource.`,
        badge: 'GRAPH',
        color: 'indigo',
      };
    }
    case 'get_service_diagnostics': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Service & endpoint diagnostics for "${args.name || ''}"${ns}`,
        description: `Inspects Service type, ClusterIP/LoadBalancer status, selectors, EndpointSlices, and matching Pod readiness.`,
        badge: 'SVC DIAG',
        color: 'sky',
      };
    }
    case 'get_pvc_diagnostics': {
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Storage diagnostics for PVC "${args.name || ''}"${ns}`,
        description: `Inspects PersistentVolumeClaim phase, StorageClass, bound PersistentVolume, capacity, and provisioning events.`,
        badge: 'PVC DIAG',
        color: 'amber',
      };
    }
    case 'get_node_diagnostics': {
      return {
        title: `Node diagnostics for "${args.name || ''}"`,
        description: `Inspects Node readiness conditions, memory/disk/PID pressure, scheduling taints, and allocatable capacity.`,
        badge: 'NODE DIAG',
        color: 'purple',
      };
    }
    case 'get_config_diagnostics': {
      const kind = args.kind || 'Resource';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `ConfigMap & Secret reference diagnostics for ${kind} "${args.name || ''}"${ns}`,
        description: `Verifies existence and key availability of referenced ConfigMaps, Secrets, and imagePullSecrets without exposing sensitive values.`,
        badge: 'CONFIG',
        color: 'sky',
      };
    }
    case 'verify_workload': {
      const kind = args.kind || 'Workload';
      const ns = args.namespace ? ` in namespace "${args.namespace}"` : '';
      return {
        title: `Verify rollout of ${kind} "${args.name || ''}"${ns}`,
        description: `Polls fresh controller state to verify observedGeneration, replica readiness, or Job completion for an accepted change.`,
        badge: 'VERIFY',
        color: 'emerald',
      };
    }
    case 'summarize_resources': {
      const kind = args.kind || 'resources';
      const ns = args.namespace ? ` in "${args.namespace}"` : '';
      return {
        title: `Summarize ${kind}${ns} by ${args.groupBy || 'health'}`,
        description: `Aggregates bounded pages of ${kind} into counts and representative examples without loading full object bodies into context.`,
        badge: 'SUMMARY',
        color: 'sky',
      };
    }
    case 'set_working_scope': {
      const ns = args.namespace ? `namespace "${args.namespace}"` : 'cleared';
      return {
        title: `Set working scope (${ns})`,
        description: args.reason || `Updates default namespace, selector, and root resource anchor for subsequent investigation queries.`,
        badge: 'SCOPE',
        color: 'slate',
      };
    }
    case 'get_evidence': {
      return {
        title: `Retrieve historical evidence ${args.evidenceId || ''}`,
        description: `Loads previously projected tool output from the session evidence store by ID.`,
        badge: 'EVIDENCE',
        color: 'slate',
      };
    }
    case 'resource_catalog': {
      return {
        title: args.discover ? 'Discover cluster API resources & CRDs' : 'Inspect built-in resource catalog',
        description: `Lists available Kubernetes API groups, versions, kinds, and namespace scope.`,
        badge: 'CATALOG',
        color: 'slate',
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
  if (name === 'run_command' && !result.error) return `Command exited ${result.exitCode ?? 'without an exit code'}`;
  if (name === 'read_skill' && !result.error) return 'Skill file loaded';
  if (name.startsWith('mcp_') && !result.error) return result.isError ? 'MCP tool reported an error' : 'MCP response received';
  if (result.error && typeof result.error === 'string') return `Failed: ${result.error}`;
  if (result.payloadOmitted) return result.operationId ? `Historical operation ${result.status ?? 'outcome unknown'} · Receipt: ${result.operationId}` : 'Historical tool payload omitted · refresh evidence';
  if (result.executed === false) return result.deferred ? 'Deferred pending user input' : 'Not executed';
  if (['scale_workload', 'restart_workload', 'delete_resource', 'apply_manifest', 'sync_argocd_app', 'reconcile_flux_resource'].includes(name)) {
    if (result.status === 'accepted') return `API accepted the request · verify outcome${result.operationId ? ` · Receipt: ${result.operationId}` : ''}`;
    if (['failed', 'cancelled', 'uncertain'].includes(result.status)) return `Change ${result.status}${result.operationId ? ` · Receipt: ${result.operationId}` : ''}`;
    return 'Change outcome unverified';
  }


  switch (name) {
    case 'list_helm_releases': {
      const releases = Array.isArray(result.releases) ? result.releases : [];
      const status = (release: any) => typeof release.status === 'string' ? release.status : release.metadata?.labels?.status;
      const deployed = releases.filter((r: any) => status(r) === 'deployed').length;
      const failed = releases.filter((r: any) => ['failed', 'pending-install', 'pending-upgrade', 'pending-rollback'].includes(status(r))).length;
      return `${releases.length} release${releases.length === 1 ? '' : 's'} inspected · ${deployed} observed deployed · ${failed} reported failed/pending${result.evidence?.completeness === 'partial' ? ' (partial coverage)' : ''}`;
    }
    case 'get_helm_release': return `Release "${typeof result.release === 'string' ? result.release : args.name ?? ''}" permitted details retrieved`;
    case 'verify_workload': return `Controller verification ${result.verification ?? 'unknown'} · application health unverified`;
    case 'summarize_resources': {
      return `${result.objectsExamined ?? 0} resources summarized${result.completeness === 'partial' ? ' (partial coverage)' : ''}`;
    }
    case 'set_working_scope': return `Investigation scope: ${result.workingScope?.namespace ?? 'explicit queries'}`;
    case 'get_evidence': return 'Historical evidence retrieved';
    case 'list_resources': {
      const items = Array.isArray(result.items) ? result.items : [];
      const kind = args.kind || 'resource';
      return `${items.length} ${kind}${items.length === 1 ? '' : 's'} inspected${result.hasMore ? ' (partial page)' : ''}`;
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
      const partial = result.evidence?.completeness !== 'complete';
      return issues > 0 ? `Diagnostics ${partial ? 'partial' : 'complete'} · ${issues} issue(s) detected` : 'No issues found in available evidence · health unverified';
    }
    case 'get_workload_diagnostics': {
      const state = result.rolloutState || 'unknown';
      const pods = Array.isArray(result.childPods) ? result.childPods.length : 0;
      const partial = result.evidence?.completeness !== 'complete';
      return `Rollout ${state} (${pods} pod${pods === 1 ? '' : 's'} checked${partial ? ', partial' : ''})`;
    }
    case 'diagnose_resource': {
      const causes = Array.isArray(result.crashCauses) ? result.crashCauses.length : 0;
      const diagIssues = Array.isArray(result.diagnostic?.issuesSummary) ? result.diagnostic.issuesSummary.length : 0;
      if (causes > 0) return `Diagnostic bundle collected · ${causes} crash cause(s) identified`;
      if (diagIssues > 0) return `Diagnostic bundle collected · ${diagIssues} issue(s) detected`;
      return 'Diagnostic bundle collected (partial coverage)';
    }
    case 'get_neighborhood': {
      const nodes = Array.isArray(result.nodes) ? result.nodes.length : 0;
      const edges = Array.isArray(result.edges) ? result.edges.length : 0;
      return `${nodes} node${nodes === 1 ? '' : 's'}, ${edges} edge${edges === 1 ? '' : 's'} mapped${result.truncated ? ' (bounded)' : ''}`;
    }
    case 'get_service_diagnostics': {
      const issues = Array.isArray(result.service?.issuesSummary) ? result.service.issuesSummary.length : 0;
      return issues > 0 ? `Service inspected · ${issues} issue(s) detected` : 'Service & endpoints inspected · health unverified';
    }
    case 'get_pvc_diagnostics': {
      const phase = result.pvc?.phase || 'unknown';
      const issues = Array.isArray(result.pvc?.issuesSummary) ? result.pvc.issuesSummary.length : 0;
      return `PVC ${phase}${issues > 0 ? ` · ${issues} issue(s)` : ''}`;
    }
    case 'get_node_diagnostics': {
      const state = result.node?.readyState || 'unknown';
      const issues = Array.isArray(result.node?.issuesSummary) ? result.node.issuesSummary.length : 0;
      return `Node ${state}${issues > 0 ? ` · ${issues} issue(s)` : ''}`;
    }
    case 'get_config_diagnostics': {
      const checks = Array.isArray(result.checks) ? result.checks.length : 0;
      const missing = Array.isArray(result.checks) ? result.checks.filter((c: any) => c.object === 'notFound' || c.keyStatus === 'unknownOrMissing').length : 0;
      return `${checks} config reference${checks === 1 ? '' : 's'} checked${missing > 0 ? ` · ${missing} missing/unknown` : ''}`;
    }
    case 'verify_workload': {
      const state = result.verification || 'unknown';
      return `Verification ${state}`;
    }
    case 'summarize_resources': {
      const scanned = typeof result.scannedCount === 'number' ? result.scannedCount : 0;
      return `${scanned} resource${scanned === 1 ? '' : 's'} summarized${result.hasMore ? ' (partial)' : ''}`;
    }
    case 'set_working_scope': {
      const ns = result.workingNamespace || args.namespace || 'cluster';
      return `Working scope set to "${ns}"`;
    }
    case 'get_evidence': {
      return `Evidence "${args.id || ''}" retrieved`;
    }
    case 'resource_catalog': {
      const kinds = Array.isArray(result.resources) ? result.resources.length : Array.isArray(result.items) ? result.items.length : 0;
      return kinds > 0 ? `${kinds} resource type${kinds === 1 ? '' : 's'} discovered` : 'Resource catalog loaded';
    }
    case 'get_events_timeline': {
      const count = Array.isArray(result.timeline) ? result.timeline.length : 0;
      return `${count} timeline event${count === 1 ? '' : 's'} analyzed`;
    }
    case 'get_events': {
      const events = Array.isArray(result.events) ? result.events : Array.isArray(result.items) ? result.items : [];
      return `${events.length} event${events.length === 1 ? '' : 's'} analyzed`;
    }
    case 'get_logs': {
      const lines = typeof result.logs === 'string' ? result.logs.split('\n').filter(Boolean).length : 0;
      if (result.filtered && typeof result.matchedErrorLines === 'number') {
        return `Filtered ${result.matchedErrorLines} error/warning line(s) from ${result.totalLines ?? lines} total`;
      }
      return `Fetched ${lines} log line${lines === 1 ? '' : 's'}`;
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

