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
    ? `Investigate ${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ''}${resource.name} (${resource.apiVersion}, UID ${resource.uid}). Explain the problem, collect permitted evidence, and suggest next steps. Do not treat missing or filtered data as proof that there is no problem.`
    : options.create ? `Create ${options.kind && options.kind !== 'Pod' ? `a ${options.kind}` : 'an application'} in Kubernetes${options.namespace ? ` in namespace ${options.namespace}` : ''}. ` : '';
  const scope = currentAgentScope(resource?.namespace ?? options.namespace);
  const create = () => {
    const settings = useAiStore.getState().settings;
    const providerId = settings.defaultProvider ?? settings.providers[0]?.id ?? '';
    const model = (providerId === settings.defaultProvider ? settings.defaultModel : '') || settings.defaultModel || '';
    return useAiStore.getState().create(
      scope,
      draft,
      resource ? `Investigate: ${resource.name}` : options.create ? 'Create with AI' : undefined,
      providerId,
      model,
    );
  };
  const store = useAiStore.getState();
  if (resource || options.create || !store.conversations.length) {
    if (store.loaded) create();
    else void store.load().then(create);
  }
  useWorkspaceStore.getState().openTab({ id: 'panel:ai-agent', type: 'extension', panelId: 'ai-agent', title: 'AI Agent', context: null });
}
