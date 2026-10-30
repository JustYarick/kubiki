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
