import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { SearchInput } from '../../../components/ui/Input';
import {
  isToolActiveInPolicy,
  patchToolInPolicy,
  summarizeMcpPolicy,
  MCP_TOOL_CATALOG,
  WRITE_OPERATIONS,
  type AgentPhase,
  type AgentPolicy,
  type WriteOperation,
} from '../types';

interface McpToolsPanelProps {
  policy: AgentPolicy;
  onChange: (next: AgentPolicy) => void | Promise<void>;
  currentPhase?: AgentPhase;
  modeScope?: 'phased' | 'general';
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  className?: string;
  disabled?: boolean;
}

export function McpToolsPanel({
  policy,
  onChange,
  modeScope = 'phased',
  onClose,
  title = 'Cluster Tools & Permissions',
  subtitle = 'Changes apply live across active sessions without restarting',
  className,
  disabled = false,
}: McpToolsPanelProps) {
  const [selectedTab, setSelectedTab] = useState<'global' | 'plan' | 'action'>('global');
  const [search, setSearch] = useState('');

  const activePhase: AgentPhase | undefined =
    modeScope === 'general' ? undefined : (selectedTab === 'global' ? undefined : selectedTab);

  const readOnly = Boolean(policy.readOnly);
  const summary = summarizeMcpPolicy(
    activePhase === 'plan'
      ? { ...policy, readOnly: true }
      : policy,
  );
  const activeCount = MCP_TOOL_CATALOG.filter(t => isToolActiveInPolicy(t.id, policy, activePhase)).length;
  const totalAvailable = activePhase === 'plan' ? MCP_TOOL_CATALOG.filter(t => t.group !== 'write').length : MCP_TOOL_CATALOG.length;

  const filteredTools = MCP_TOOL_CATALOG.filter(t =>
    t.label.toLowerCase().includes(search.toLowerCase()) || t.id.toLowerCase().includes(search.toLowerCase()),
  );

  function toggleWriteOp(op: WriteOperation, enabled: boolean) {
    const nextWrites = enabled
      ? Array.from(new Set([...policy.writes, op]))
      : policy.writes.filter(w => w !== op);
    const mappedTool =
      op === 'create' || op === 'update'
        ? 'apply_manifest'
        : op === 'scale'
          ? 'scale_workload'
          : op === 'restart'
            ? 'restart_workload'
            : 'delete_resource';
    const nextDisabled = enabled
      ? (policy.disabledTools ?? []).filter(id => id !== mappedTool)
      : policy.disabledTools ?? [];
    const nextActionDisabled = enabled
      ? (policy.actionDisabledTools ?? []).filter(id => id !== mappedTool)
      : policy.actionDisabledTools ?? [];
    void onChange({
      ...policy,
      writes: nextWrites,
      readOnly: enabled ? false : policy.readOnly,
      disabledTools: nextDisabled,
      actionDisabledTools: nextActionDisabled,
    });
  }

  function handleEnableAll() {
    if (activePhase === 'plan') {
      void onChange({ ...policy, planDisabledTools: [] });
    } else if (activePhase === 'action') {
      void onChange({
        ...policy,
        actionDisabledTools: [],
        disabledTools: [],
        readOnly: false,
        writes: WRITE_OPERATIONS,
        logs: true,
        clusterResources: true,
        resources: true,
        events: true,
        metrics: true,
      });
    } else {
      void onChange({
        ...policy,
        disabledTools: [],
        planDisabledTools: [],
        actionDisabledTools: [],
        readOnly: false,
        writes: WRITE_OPERATIONS,
        logs: true,
        clusterResources: true,
        resources: true,
        events: true,
        metrics: true,
      });
    }
  }

  return (
    <div
      className={`ai-settings-card flex flex-col gap-3 ${className ?? ''}`}
      role="region"
      aria-label="MCP tools and permissions control"
    >
      <div className="ai-card-header mb-0 pb-2.5 border-b border-[var(--border-subtle)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4>{title}</h4>
            <span
              className={`ai-status-pill font-mono ${activeCount > 0 ? 'is-active' : ''}`}
              title="Active tools available in this mode"
            >
              {activeCount}/{totalAvailable} active
            </span>
            <span
              className={`ai-status-pill font-mono ${summary.isReadOnly ? 'is-active' : 'is-warn'}`}
              title={
                summary.isReadOnly
                  ? 'No mutation tools active (Read-only)'
                  : `Mutations permitted: ${summary.allowedWrites.join(', ')}`
              }
            >
              {summary.isReadOnly ? 'RO' : 'RW'}
            </span>
          </div>
          <p className="ai-help mt-0.5">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {modeScope === 'phased' && (
            <div className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-canvas)] p-0.5">
              {([
                { id: 'global', label: 'Common', title: 'Configure shared baseline tool permissions across Kubiki Agent and MCP Action profile' },
                { id: 'plan', label: 'Plan (Kubiki)', title: 'Configure tools available during Kubiki Agent Plan phase' },
                { id: 'action', label: 'Action (Kubiki)', title: 'Configure tools available during Kubiki Agent Action phase' },
              ] as const).map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  className={`h-[var(--control-h-xs)] px-2 rounded-[3px] text-[11px] transition-colors ${
                    selectedTab === tab.id
                      ? 'bg-[var(--accent)] text-white font-medium'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  onClick={() => setSelectedTab(tab.id)}
                  title={tab.title}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          <Button size="sm" variant="secondary" disabled={disabled} onClick={handleEnableAll} title="Enable all permitted tools and categories for this view">
            Enable all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void onChange({
              ...policy,
              readOnly: false,
              writes: [],
              rules: (policy.rules ?? []).map(r => ({ ...r, writes: [] })),
            })}
            title="Disable all cluster mutations in this profile while keeping customizations"
          >
            Clear writes
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close MCP tools panel" title="Close panel">
              ✕
            </Button>
          )}
        </div>
      </div>

      {modeScope === 'phased' ? (
        <p className="ai-help">
          {activePhase === 'plan' && 'Plan phase (Kubiki Agent only): mutation tools stay blocked by the planning safety contract.'}
          {activePhase === 'action' && 'Action phase (Kubiki Agent only): configure which tools are restricted specifically during Kubiki Action.'}
          {!activePhase && 'Common (Shared): baseline permissions shared across Kubiki Agent and the MCP Action profile.'}
        </p>
      ) : (
        <p className="ai-help">
          External clients manage their own modes, so tools here apply globally without Plan/Action gating.
        </p>
      )}

      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Data access</span>
        <div className="ai-permission-checks">
          {([
            { key: 'resources', label: 'Resources', title: 'Allow reading Kubernetes workload, config and network objects' },
            { key: 'events', label: 'Events', title: 'Allow reading cluster and namespace warning and informational events' },
            { key: 'logs', label: 'Logs', title: 'Allow streaming container and previous crash logs' },
            { key: 'metrics', label: 'Metrics', title: 'Allow querying CPU and memory usage statistics' },
            { key: 'clusterResources', label: 'Cluster resources', title: 'Allow reading non-namespaced resources (Nodes, Namespaces, StorageClasses)' },
            { key: 'workloadConfiguration', label: 'Inline env & commands', title: 'Expose Pod container environment variables, startup commands and probe header values' },
            { key: 'annotations', label: 'Annotations', title: 'Include Kubernetes object annotations in responses' },
            { key: 'helmValues', label: 'Helm release values', title: 'Allow reading Helm release chart values and full revision history (helm action=values). Metadata-only list and storage revision checks work without this toggle.' },
          ] as const).map(({ key, label, title: tip }) => (
            <CheckboxRow
              key={key}
              label={label}
              title={tip}
              checked={Boolean(policy[key])}
              disabled={disabled}
              onChange={e => void onChange({ ...policy, [key]: e.target.checked })}
            />
          ))}
        </div>
      </div>

      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Allowed changes</span>
          {activePhase === 'plan' && (
            <span className="text-[10.5px] text-amber-400 font-medium" title="Planning phase is read-only by design">
              Mutations disabled in Plan mode
            </span>
          )}
        </div>
        <div className="ai-permission-checks">
          {WRITE_OPERATIONS.map(op => {
            const tooltips: Record<WriteOperation, string> = {
              create: 'Allow creating new resources via apply_manifest',
              update: 'Allow modifying existing resources via apply_manifest',
              scale: 'Allow scaling workload replicas via scale_workload',
              restart: 'Allow rolling restarts of controllers via restart_workload',
              delete: 'Allow deleting resources via delete_resource',
            };
            const labels: Record<WriteOperation, string> = {
              create: 'Create',
              update: 'Update',
              scale: 'Scale',
              restart: 'Restart',
              delete: 'Delete',
            };
            const isPlanBlocked = activePhase === 'plan';
            return (
              <CheckboxRow
                key={op}
                label={labels[op]}
                title={tooltips[op]}
                checked={!isPlanBlocked && !readOnly && policy.writes.includes(op)}
                disabled={disabled || isPlanBlocked}
                onChange={e => toggleWriteOp(op, e.target.checked)}
              />
            );
          })}
        </div>
      </div>

      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            Tools catalog ({filteredTools.length})
          </span>
          <SearchInput
            size="sm"
            className="w-52 max-w-full"
            placeholder="Search tools..."
            value={search}
            onChange={setSearch}
          />
        </div>
        <div className="ai-permission-checks max-h-60 overflow-y-auto kubiki-scrollbar pr-1">
          {filteredTools.map(tool => {
            const blockedByPlan = activePhase === 'plan' && tool.group === 'write';
            const enabled = isToolActiveInPolicy(tool.id, policy, activePhase);
            const tooltip = `${tool.id}\n${tool.description}${blockedByPlan ? '\n(Blocked: mutation tool in Plan mode)' : ''}`;
            return (
              <CheckboxRow
                key={tool.id}
                label={tool.label}
                title={tooltip}
                checked={enabled}
                disabled={disabled || blockedByPlan}
                onChange={e => void onChange(patchToolInPolicy(tool.id, e.target.checked, policy, activePhase))}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
