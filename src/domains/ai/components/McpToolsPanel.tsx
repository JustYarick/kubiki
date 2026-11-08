import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
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
  title = 'MCP Cluster Tools & Permissions',
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
      className={`p-3 bg-[var(--bg-secondary)] space-y-3 max-h-[56vh] overflow-y-auto kubiki-scrollbar ${className ?? ''}`}
      role="region"
      aria-label="MCP tools and permissions control"
    >
      {/* Header with Title and Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-[var(--border-subtle)]">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold text-[var(--text-primary)] m-0">{title}</h4>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-mono border ${
                activeCount > 0
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-[var(--bg-card)] border-[var(--border-default)] text-[var(--text-muted)]'
              }`}
              title="Active tools available to the agent in this mode"
            >
              {activeCount}/{totalAvailable} active
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Segmented Phase Switcher */}
          <div className="inline-flex rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] p-0.5 text-xs">
            <button
              type="button"
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                selectedTab === 'current'
                  ? 'bg-[var(--accent)] text-white font-medium shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setSelectedTab('current')}
              title={`View tools active in the current phase (${currentPhase})`}
            >
              Current ({currentPhase})
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                selectedTab === 'plan'
                  ? 'bg-[var(--accent)] text-white font-medium shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setSelectedTab('plan')}
              title="Configure tools available during the investigation and planning phase"
            >
              Plan Mode
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                selectedTab === 'action'
                  ? 'bg-[var(--accent)] text-white font-medium shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setSelectedTab('action')}
              title="Configure tools and write permissions during execution and changes"
            >
              Action Mode
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                selectedTab === 'global'
                  ? 'bg-[var(--accent)] text-white font-medium shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setSelectedTab('global')}
              title="Configure baseline permissions and global data access"
            >
              Global
            </button>
          </div>

          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={handleEnableAll}
            title="Enable all permitted tools and categories for this mode"
          >
            Enable all
          </Button>
          <Button
            size="sm"
            variant={readOnly ? 'primary' : 'ghost'}
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

      {/* Mode Note / Sub-Status Bar */}
      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] py-0.5">
        <span>
          {activePhase === 'plan' && 'Plan Phase: mutation tools are blocked by safety contract. Read and diagnostic tools only.'}
          {activePhase === 'action' && 'Action Phase: write operations and verifications enabled according to policy.'}
          {!activePhase && 'Global Policy: baseline permissions applied across all phases.'}
        </span>
        {readOnly && (
          <span className="text-amber-400 font-medium text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20" title="All mutations are blocked globally">
            Read-only active
          </span>
        )}
      </div>

      {/* Data Categories Master Toggles */}
      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Data access:</span>
        <div className="flex flex-wrap items-center gap-3">
          {([
            { key: 'resources', label: 'Resources', title: 'Allow reading Kubernetes workload, config and network objects' },
            { key: 'events', label: 'Events', title: 'Allow reading cluster and namespace warning and informational events' },
            { key: 'logs', label: 'Logs', title: 'Allow streaming container and previous crash logs' },
            { key: 'metrics', label: 'Metrics', title: 'Allow querying CPU and memory usage statistics' },
            { key: 'clusterResources', label: 'Cluster resources', title: 'Allow reading non-namespaced resources (Nodes, Namespaces, StorageClasses)' },
          ] as const).map(({ key, label, title }) => (
            <CheckboxRow
              key={key}
              label={label}
              title={title}
              checked={policy[key]}
              disabled={disabled}
              onChange={e => void onChange({ ...policy, [key]: e.target.checked })}
            />
          ))}
        </div>
      </div>

      {/* Allowed Changes (Writes) */}
      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Allowed changes:</span>
          {activePhase === 'plan' && (
            <span className="text-[10px] text-amber-400 font-medium" title="Planning phase is read-only by design">
              Mutations disabled in Plan mode
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
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

      {/* Individual MCP tools */}
      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-[var(--text-secondary)]">
            Tools catalog ({filteredTools.length}):
          </div>
          <div className="relative">
            <input
              type="search"
              placeholder="Search tools..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="text-xs pl-2 pr-6 py-1 rounded bg-[var(--bg-card)] border border-[var(--border-default)] text-[var(--text-primary)] w-48 placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              title="Search by tool name or ID"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto kubiki-scrollbar pr-1">
          {filteredTools.map(tool => {
            const blockedByReadOnly = (readOnly || activePhase === 'plan') && tool.group === 'write';
            const enabled = isToolActiveInPolicy(tool.id, policy, activePhase);
            const tooltip = `${tool.id}\n${tool.description}${blockedByReadOnly ? '\n(Blocked: mutation tool in read-only / plan phase)' : ''}`;
            return (
              <div
                key={tool.id}
                className="flex items-center px-1.5 py-1 rounded hover:bg-[var(--bg-hover)] transition-colors min-w-0"
                title={tooltip}
              >
                <CheckboxRow
                  label={tool.label}
                  title={tooltip}
                  checked={enabled}
                  disabled={disabled || blockedByReadOnly}
                  onChange={e => void onChange(patchToolInPolicy(tool.id, e.target.checked, policy, activePhase))}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
