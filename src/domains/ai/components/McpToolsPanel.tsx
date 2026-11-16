import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { SearchInput } from '../../../components/ui/Input';
import {
  isToolActiveInPolicy,
  patchToolInPolicy,
  toggleReadOnlyMcpPolicy,
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
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  className?: string;
  disabled?: boolean;
}

export function McpToolsPanel({
  policy,
  onChange,
  currentPhase = 'action',
  onClose,
  title = 'Cluster Tools & Permissions',
  subtitle = 'Changes apply live to active sessions without restarting',
  className,
  disabled = false,
}: McpToolsPanelProps) {
  const [selectedTab, setSelectedTab] = useState<'current' | 'plan' | 'action' | 'global'>('current');
  const [search, setSearch] = useState('');

  const activePhase: AgentPhase | undefined =
    selectedTab === 'current' ? (currentPhase === 'plan' ? 'plan' : 'action') : selectedTab === 'global' ? undefined : selectedTab;

  const readOnly = Boolean(policy.readOnly);
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
              title="Active tools available to the agent in this mode"
            >
              {activeCount}/{totalAvailable} active
            </span>
            {readOnly && (
              <span className="ai-status-pill is-warn" title="All mutations are blocked globally">
                Read-only
              </span>
            )}
          </div>
          <p className="ai-help mt-0.5">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-canvas)] p-0.5">
            {([
              { id: 'current', label: `Current (${currentPhase})`, title: `View tools active in the current phase (${currentPhase})` },
              { id: 'plan', label: 'Plan', title: 'Configure tools available during the investigation and planning phase' },
              { id: 'action', label: 'Action', title: 'Configure tools and write permissions during execution and changes' },
              { id: 'global', label: 'Global', title: 'Configure baseline permissions and global data access' },
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

          <Button size="sm" variant="secondary" disabled={disabled} onClick={handleEnableAll} title="Enable all permitted tools and categories for this mode">
            Enable all
          </Button>
          <Button
            size="sm"
            variant={readOnly ? 'primary' : 'secondary'}
            disabled={disabled}
            onClick={() => void onChange(toggleReadOnlyMcpPolicy(!readOnly, policy))}
            title={readOnly ? 'Disable read-only mode to allow resource changes' : 'Lock the agent into read-only mode (blocks all mutations)'}
          >
            {readOnly ? 'Read-only ON' : 'Read-only OFF'}
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close MCP tools panel" title="Close panel">
              ✕
            </Button>
          )}
        </div>
      </div>

      <p className="ai-help">
        {activePhase === 'plan' && 'Plan phase: mutation tools are blocked by safety contract. Read and diagnostic tools only.'}
        {activePhase === 'action' && 'Action phase: write operations and verifications enabled according to policy.'}
        {!activePhase && 'Global policy: baseline permissions applied across all phases.'}
      </p>

      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Data access</span>
        <div className="ai-permission-checks">
          {([
            { key: 'resources', label: 'Resources', title: 'Allow reading Kubernetes workload, config and network objects' },
            { key: 'events', label: 'Events', title: 'Allow reading cluster and namespace warning and informational events' },
            { key: 'logs', label: 'Logs', title: 'Allow streaming container and previous crash logs' },
            { key: 'metrics', label: 'Metrics', title: 'Allow querying CPU and memory usage statistics' },
            { key: 'clusterResources', label: 'Cluster resources', title: 'Allow reading non-namespaced resources (Nodes, Namespaces, StorageClasses)' },
          ] as const).map(({ key, label, title: tip }) => (
            <CheckboxRow
              key={key}
              label={label}
              title={tip}
              checked={policy[key]}
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
            const isBlocked = readOnly || activePhase === 'plan';
            return (
              <CheckboxRow
                key={op}
                label={labels[op]}
                title={tooltips[op]}
                checked={!isBlocked && policy.writes.includes(op)}
                disabled={disabled || isBlocked}
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
            const blockedByReadOnly = (readOnly || activePhase === 'plan') && tool.group === 'write';
            const enabled = isToolActiveInPolicy(tool.id, policy, activePhase);
            const tooltip = `${tool.id}\n${tool.description}${blockedByReadOnly ? '\n(Blocked: mutation tool in read-only / plan phase)' : ''}`;
            return (
              <CheckboxRow
                key={tool.id}
                label={tool.label}
                title={tooltip}
                checked={enabled}
                disabled={disabled || blockedByReadOnly}
                onChange={e => void onChange(patchToolInPolicy(tool.id, e.target.checked, policy, activePhase))}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
