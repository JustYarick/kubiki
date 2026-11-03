import { namespaceNames } from '../../core/resources/namespace_scope';
import { useClusterStore } from '../../state/cluster_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import type { ResourceItem } from '../../types/k8s';
import { useAiStore } from './store';
import type { AgentScope } from './types';

export function currentAgentScope(namespace?: string): AgentScope {
  const cluster = useClusterStore.getState();
  const names = namespace ? [namespace] : namespaceNames(cluster.selectedNamespace);
  return { context: cluster.currentContext ?? '', namespaces: names ?? [], allNamespaces: names === null };
}
export function openAiChat(options: { resource?: ResourceItem; create?: boolean; kind?: string; namespace?: string } = {}) {
  const resource = options.resource;
  // Attach identity only. Live object data must pass through native policy,
  // including when invoked from a Secret/ConfigMap inspector.
  const draft = resource
    ? `Analyze ${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ''}${resource.name} (${resource.apiVersion}, UID ${resource.uid}). Investigate the problem using permitted evidence. Then deliver the diagnosis, uncertainty and a structured remediation plan via propose_plan (kind=remediation), with concrete ordered fix steps, risk and verification. If the cause remains unknown, propose precise next checks instead of guessing a fix. Do not treat missing or filtered data as proof that there is no problem.`
    : options.create ? `Create ${options.kind && options.kind !== 'Pod' ? `a ${options.kind}` : 'an application'} in Kubernetes${options.namespace ? ` in namespace ${options.namespace}` : ''}. ` : '';
  const scope = currentAgentScope(resource?.namespace ?? options.namespace);
  const create = () => {
    const settings = useAiStore.getState().settings;
    if((settings.runtime ?? 'kubiki')!=='kubiki') {
      const id=crypto.randomUUID();
      useAiStore.setState({openCodeRequest:{id,scope,prompt:draft.replace('a structured remediation plan via propose_plan (kind=remediation)', 'a remediation plan') + (resource ? ' Use the connected Kubiki cluster tools, starting with diagnose_resource for this exact identity. Follow ownerReferences and UID, never infer Deployment from a Pod name. If cluster tools are unavailable, report that blocker and stop; do not inspect host configs, credentials or sockets.' : '')}});
      return id;
    }
    const providerId = settings.defaultProvider ?? settings.providers[0]?.id ?? '';
    const model = (providerId === settings.defaultProvider ? settings.defaultModel : '') || settings.defaultModel || '';
    const id=useAiStore.getState().create(
      scope,
      draft,
      resource ? `Analyze: ${resource.name}` : options.create ? 'Create with AI' : undefined,
      providerId,
      model,
    );
    useAiStore.getState().update(id,{intent:resource?'investigate':options.create?'create':'chat'});
    return id;
  };
  const store = useAiStore.getState();
  if (resource || options.create) {
    if (store.loaded) create();
    else void store.load().then(create);
  } else {
    const isTabOpen = useWorkspaceStore.getState().tabs.some(t => t.id === 'panel:ai-agent');
    if (!isTabOpen) {
      useAiStore.setState({ activeId: null });
    }
  }
  useWorkspaceStore.getState().openTab({ id: 'panel:ai-agent', type: 'extension', panelId: 'ai-agent', title: 'AI Agent', context: null });
}
