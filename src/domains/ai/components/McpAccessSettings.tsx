import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, desktopAiAvailable } from '../transport';
import { normalizeMcpPolicy, syncSharedPolicyFields, type AgentPolicy } from '../types';
import { DataSelect } from './AgentSettings';
import { McpToolsPanel } from './McpToolsPanel';

export function McpAccessSettings() {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const activeId = useAiStore(s => s.activeId);
  const activeConversation = useAiStore(s => s.conversations.find(c => c.id === activeId));
  const activePhase = activeConversation?.phase ?? 'action';
  const [draft, setDraft] = useState(normalizeMcpPolicy(settings.mcpPolicy));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(normalizeMcpPolicy(settings.mcpPolicy));
  }, [settings.mcpPolicy]);

  async function persist(next: AgentPolicy, msg = 'Cluster tool access applied live to MCP.') {
    setDraft(next);
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      const nextMcp: AgentPolicy = { ...next, alwaysAsk: [], confirmReads: false, rules: [] };
      await useAiStore.getState().save({
        ...cur,
        mcpPolicy: nextMcp,
        policy: syncSharedPolicyFields(nextMcp, cur.policy),
      });
      setMessage(msg);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function save() {
    await persist(draft, 'Cluster tool access saved and applied live.');
  }

  return (
    <section className="ai-settings-section" aria-label="Kubiki MCP access">
      <div className="ai-section-header">
        <h3>Cluster tools & permissions (MCP)</h3>
        <Button size="sm" disabled={saving || !desktopAiAvailable()} onClick={() => void save()}>
          Save cluster access
        </Button>
      </div>
      <p className="ai-help">
        Configure cluster tools, data permissions, and Plan/Action mode boundaries. These settings apply to both Kubiki and external agents (OpenCode, Codex, Claude Code) in real time.
      </p>

      {/* Embedded unified live tools panel */}
      <div className="rounded border border-[var(--border-default)] overflow-hidden">
        <McpToolsPanel
          policy={draft}
          onChange={next => void persist(next)}
          currentPhase={activePhase}
          title="Cluster Tools & Mode Permissions"
          subtitle="Toggling Plan / Action tabs lets you configure which tools are permitted during planning vs execution"
        />
      </div>

      <div className="ai-settings-card mt-3">
        <h4>Detailed Data Access Levels</h4>
        {(['secrets', 'configMaps', 'customResources'] as const).map(key => {
          const titles: Record<'secrets' | 'configMaps' | 'customResources', string> = {
            secrets: 'Control exposure of Secret keys and payloads to the agent',
            configMaps: 'Control whether ConfigMap data contents or metadata only are readable',
            customResources: 'Control access permissions for installed Custom Resource Definitions (CRDs)',
          };
          return (
            <DataSelect
              key={key}
              label={{ secrets: 'Secrets', configMaps: 'ConfigMaps', customResources: 'Custom resources' }[key]}
              title={titles[key]}
              value={draft[key]}
              onChange={val => void persist({ ...draft, [key]: val })}
            />
          );
        })}
        <label className="ai-field mt-2" title="Maximum allowed replica count for workload scaling operations">
          Maximum replicas
          <Input
            type="number"
            min={0}
            max={10000}
            value={draft.maxReplicas}
            onChange={e => setDraft({ ...draft, maxReplicas: Number(e.target.value) })}
          />
        </label>
      </div>

      <details className="ai-settings-card">
        <summary title="Click to expand or collapse cluster context, namespace, and field exclusion rules">
          Cluster context, namespace, and field rules
        </summary>
        {(['contexts', 'namespaces', 'deniedPaths'] as const).map(key => {
          const labels = {
            contexts: 'Allowed contexts',
            namespaces: 'Allowed namespaces',
            deniedPaths: 'Fields to exclude',
          };
          const tooltips = {
            contexts: 'One context name per line (* matches any cluster context)',
            namespaces: 'One namespace per line (* matches any namespace)',
            deniedPaths: 'JSON/YAML paths to redact (e.g. /spec/template/spec/containers/0/env)',
          };
          const placeholders = {
            contexts: 'e.g. minikube\n* (all clusters)',
            namespaces: 'e.g. default\nproduction',
            deniedPaths: '/spec/template/spec/containers/0/env\n/data/private.key',
          };
          return (
            <label className="ai-field" key={key} title={tooltips[key]}>
              {labels[key]}
              <textarea
                className="ide-textarea"
                rows={3}
                placeholder={placeholders[key]}
                value={draft[key].join('\n')}
                onChange={e =>
                  setDraft({
                    ...draft,
                    [key]: e.target.value
                      .split('\n')
                      .map(s => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          );
        })}
      </details>
      {message && <p role="status" className="ai-help">{message}</p>}
      {error && <p role="alert" className="ai-error">{error}</p>}
    </section>
  );
}
