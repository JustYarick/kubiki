import { resourceIcon } from '../../../core/resource_icons';
import { resourceBucket } from '../../../core/resources/custom_resource_types';
import { matchesResourceRef, resourceKey } from '../../../core/resources/identity';
import React from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Pin,
  ExternalLink,
  X,
  FileText,
  Terminal,
  ArrowRightLeft,
  GitBranch,
  MoreHorizontal,
  Trash2,
  RotateCw,
  Radio,
  ShieldBan,
  ShieldAlert,
} from 'lucide-react';
import type { ResourceItem } from '../../../types/k8s';
import { kindTone } from '../../../core/perspectives';
import { parseApiVersion } from '../../../core/resources/resource_types';
import { useResourceStore } from '../../../state/resource_store';
import { useUiStore } from '../../../state/ui_store';
import { useWorkspaceStore } from '../../../state/workspace_store';
import { IconButton, Button } from '../../ui/Button';
import { toast } from '../../../state/notifications_store';
import { stringify } from 'yaml';
import { MenuList, Popover, type MenuItem } from '../../ui/Dropdown';

export interface ResourceHeaderProps {
  item: ResourceItem;
  inspector?: boolean;
  onClose?: () => void;
  onBack?: () => void;
  backTarget?: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs?: () => void;
  onShell?: () => void;
  onPorts?: () => void;
  onRestart?: () => void;
  onDelete?: () => void;
  onCordon?: () => void;
  onDrain?: () => void;
  onAttach?: () => void;
  rightTab: string;
  setTab: (tab: any) => void;
  tabPrefix: string;
  tabs?: readonly { id: string; label: string }[];
  actions?: React.ReactNode;
  copyActions?: readonly { label: string; value: string }[];
}

export function ResourceHeader({
  item,
  inspector = false,
  onClose,
  onBack,
  backTarget,
  onNavigate,
  onLogs,
  onShell,
  onPorts,
  onRestart,
  onDelete,
  onCordon,
  onDrain,
  onAttach,
  rightTab,
  setTab,
  tabPrefix,
  tabs,
  actions,
  copyActions,
}: ResourceHeaderProps) {
  const resources = useResourceStore((s) => s.resources);
  const inspectorPinned = useUiStore((s) => s.inspectorPinned);
  const nativeKind = resourceBucket(item).startsWith('custom:') ? '' : item.kind;
  const Icon = resourceIcon(item.kind, item.apiVersion);

  // Build breadcrumbs through ownerReferences hierarchy:
  // e.g. Deployment -> ReplicaSet -> Pod
  const breadcrumbs: Array<{ kind: string; name: string; item?: ResourceItem }> = [];
  let curr: ResourceItem | undefined = item;
  const visited = new Set<string>();

  while (curr && !visited.has(resourceKey(curr))) {
    visited.add(resourceKey(curr));
    const metadata = (curr.raw?.metadata ?? {}) as any;
    const owners: any[] = metadata.ownerReferences ?? [];
    if (!owners.length) break;

    const topOwner: any = owners[0];
    const parentKindMap = resources[resourceBucket(topOwner)];
    const currNs: string | undefined = curr.namespace;
    const parent: ResourceItem | undefined = parentKindMap
      ? [...parentKindMap.values()].find(
          (r: ResourceItem) => matchesResourceRef(r, { ...topOwner, namespace: r.namespace === undefined ? undefined : currNs })
        )
      : undefined;

    breadcrumbs.unshift({
      kind: topOwner.kind,
      name: topOwner.name,
      item: parent,
    });

    curr = parent;
  }

  // Copy helper
  const copyText = (text: string, label: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`Copied ${label}`))
      .catch(() => toast.error('Clipboard unavailable'));
  };

  // Generate clean YAML
  const copyCleanYaml = () => {
    try {
      const clone = JSON.parse(JSON.stringify(item.raw ?? {}));
      if (clone.metadata) {
        delete clone.metadata.managedFields;
        delete clone.metadata.generation;
        delete clone.metadata.resourceVersion;
        delete clone.metadata.uid;
        delete clone.metadata.creationTimestamp;
      }
      delete clone.status;
      const clean = stringify(clone);
      copyText(clean, 'clean YAML');
    } catch {
      toast.error('Failed to generate clean YAML');
    }
  };

  const dnsName = `${item.name}.${item.namespace || 'default'}.svc.cluster.local`;

  const copyItems: MenuItem[] = copyActions
    ? copyActions.map(action => ({ id: action.label, label: action.label, onSelect: () => copyText(action.value, action.label) }))
    : [
      { id: 'name', label: 'Resource name', onSelect: () => copyText(item.name, 'resource name') },
      { id: 'yaml', label: 'Clean YAML', onSelect: copyCleanYaml },
      { id: 'get', label: 'kubectl get', onSelect: () => copyText(`kubectl get ${item.kind.toLowerCase()} ${item.name}${item.namespace ? ` -n ${item.namespace}` : ''}`, 'kubectl get command') },
      { id: 'describe', label: 'kubectl describe', onSelect: () => copyText(`kubectl describe ${item.kind.toLowerCase()} ${item.name}${item.namespace ? ` -n ${item.namespace}` : ''}`, 'kubectl describe command') },
      ...(nativeKind === 'Service' ? [{ id: 'dns', label: 'Service DNS name', onSelect: () => copyText(dnsName, 'DNS name') }] : []),
    ];

  return (
    <div className="details-header">
      {/* Top Row: Breadcrumbs / Back, Icon, Name, Actions */}
      <div className="details-identity">
        {(inspector || onBack) && (
          <div className={onBack ? 'details-back' : 'details-back details-back-empty'}><IconButton
            icon={ArrowLeft}
            size="sm"
            onClick={onBack}
            disabled={!onBack}
            aria-label="Back to previous resource"
            aria-description={backTarget ? `Back to ${backTarget.kind}/${backTarget.name}${backTarget.namespace ? ` in ${backTarget.namespace}` : ''}` : undefined}
            tooltip={backTarget ? `Back to ${backTarget.kind}/${backTarget.name}${backTarget.namespace ? ` · ${backTarget.namespace}` : ''}` : 'Back (history)'}
          /></div>
        )}

        <Icon aria-hidden="true" size="calc(16px * var(--ui-factor))" className="details-kind-icon shrink-0" style={{ color: kindTone(item.kind, item.apiVersion ? parseApiVersion(item.apiVersion).group : undefined).color }} />

        {/* Breadcrumb + Title Area */}
        <div className="min-w-0 flex-1">
          <div className="details-title truncate select-text text-[var(--text-primary)]" title={item.name}>{item.name}</div>
          <div className="details-subtitle">
            <span className="min-w-0 truncate" title={`${item.kind} · ${item.namespace || 'Cluster scoped'}`}>{item.kind} · {item.namespace || 'Cluster scoped'}</span>
            {breadcrumbs.length > 0 && <span className="details-owners" aria-label="Owner resources">
              {breadcrumbs.map((crumb, index) => <React.Fragment key={`${crumb.kind}/${crumb.name}/${index}`}>
                <ChevronRight size="calc(10px * var(--ui-factor))" aria-hidden="true" className="shrink-0" />
                {crumb.item ? <button type="button" onClick={() => onNavigate(crumb.item!)} className="hover:text-[var(--accent-text)] hover:underline" title={`${crumb.kind}/${crumb.name}`}>{crumb.name}</button>
                  : <span title={`${crumb.kind}/${crumb.name}`}>{crumb.name}</span>}
              </React.Fragment>)}
            </span>}
          </div>
        </div>

        <div className="details-header-secondary">
          <Popover align="end" width={220} trigger={() => <IconButton icon={Copy} size="sm" aria-label="Copy as…" aria-haspopup="menu" tooltip="Copy as…" />}>
            {close => <div role="menu" aria-label="Copy as…"><MenuList autoFocus items={copyItems} onSelect={action => { close(); action.onSelect?.(); }} /></div>}
          </Popover>
        </div>

        {/* Pin inspector */}
        {inspector && (
          <IconButton
            icon={Pin}
            className="details-header-secondary"
            size="sm"
            aria-label="Keep details on Overview"
            aria-pressed={inspectorPinned}
            active={inspectorPinned}
            tooltip="Keep details on Overview"
            onClick={() => useUiStore.setState({ inspectorPinned: !inspectorPinned })}
          />
        )}

        {/* Open in dedicated workspace tab */}
        <IconButton
          icon={ExternalLink}
          className="details-header-secondary"
          size="sm"
          aria-label="Open details in tab"
          tooltip="Open in editor tab"
          onClick={() => useWorkspaceStore.getState().openResourceDetail(item)}
        />

        {/* Delete button (Lens feature parity) */}
        {onDelete && (
          <IconButton
            icon={Trash2}
            className="details-header-secondary text-[var(--status-danger)] hover:bg-red-500/10"
            size="sm"
            aria-label={`Delete ${item.kind}`}
            tooltip={`Delete ${item.kind}`}
            onClick={onDelete}
          />
        )}

        <div className="details-header-overflow">
          <Popover align="end" width={220} trigger={() => <IconButton icon={MoreHorizontal} size="sm" aria-label="Details panel actions" aria-haspopup="menu" tooltip="Details panel actions" />}>
            {close => <div role="menu" aria-label="Details panel actions"><MenuList autoFocus items={[
              ...copyItems.map(action => ({ ...action, id: `copy-${action.id}`, label: `Copy ${action.label.toLowerCase()}`, icon: Copy })),
              ...(inspector ? [{ id: 'pin', label: inspectorPinned ? 'Unpin details from Overview' : 'Keep details on Overview', icon: Pin, checked: inspectorPinned, onSelect: () => useUiStore.setState({ inspectorPinned: !inspectorPinned }) }] : []),
              { id: 'open-tab', label: 'Open details in tab', icon: ExternalLink, onSelect: () => useWorkspaceStore.getState().openResourceDetail(item) },
              ...(onDelete ? [{ id: 'delete', label: `Delete ${item.kind}`, icon: Trash2, danger: true, onSelect: onDelete }] : []),
            ] satisfies MenuItem[]} onSelect={action => { close(); action.onSelect?.(); }} /></div>}
          </Popover>
        </div>

        {/* Close */}
        {onClose && <IconButton icon={X} size="sm" onClick={onClose} aria-label="Close details" />}
      </div>

      {/* Action Buttons Toolbar */}
      <div className="details-actions">
        {actions ?? <>{['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(nativeKind) && (
          <Button size="sm" aria-label="Logs" title="Open logs" onClick={onLogs}>
            <FileText size="calc(12px * var(--ui-factor))" /><span className="details-action-label">Logs</span>
          </Button>
        )}

        {['Pod', 'Node'].includes(nativeKind) && (
          <Button size="sm" aria-label={item.kind === 'Node' ? 'Node shell' : 'Shell'} title="Open shell" onClick={onShell}>
            <Terminal size="calc(12px * var(--ui-factor))" /><span className="details-action-label">{item.kind === 'Node' ? 'Node shell' : 'Shell'}</span>
          </Button>
        )}

        {nativeKind === 'Pod' && onAttach && (
          <Button size="sm" aria-label="Attach" title="Attach to process" onClick={onAttach}>
            <Radio size="calc(12px * var(--ui-factor))" /><span className="details-action-label">Attach</span>
          </Button>
        )}

        {['Deployment', 'StatefulSet', 'DaemonSet'].includes(nativeKind) && onRestart && (
          <Button size="sm" aria-label="Restart" title="Restart rollout" onClick={onRestart}>
            <RotateCw size="calc(12px * var(--ui-factor))" /><span className="details-action-label">Restart</span>
          </Button>
        )}

        {nativeKind === 'Node' && onCordon && (
          <Button size="sm" aria-label="Cordon node" title="Toggle cordon" onClick={onCordon}>
            <ShieldBan size="calc(12px * var(--ui-factor))" />
            <span className="details-action-label">{item.raw?.spec?.unschedulable ? 'Uncordon' : 'Cordon'}</span>
          </Button>
        )}

        {nativeKind === 'Node' && onDrain && (
          <Button size="sm" aria-label="Drain node" title="Drain node" onClick={onDrain}>
            <ShieldAlert size="calc(12px * var(--ui-factor))" />
            <span className="details-action-label">Drain</span>
          </Button>
        )}

        {['Pod', 'Service'].includes(nativeKind) && (
          <Button size="sm" aria-label="Ports" title="Port forwarding" onClick={onPorts}>
            <ArrowRightLeft size="calc(12px * var(--ui-factor))" /><span className="details-action-label">Ports</span>
          </Button>
        )}

        <Button
          size="sm"
          aria-label="Topology"
          title="Open topology"
          onClick={() =>
            useWorkspaceStore
              .getState()
              .openTopology(item.kind === 'Namespace' ? undefined : item, item.kind === 'Namespace' ? item.name : undefined)
          }
        >
          <GitBranch size="calc(12px * var(--ui-factor))" /><span className="details-action-label">Topology</span>
        </Button>
        </>}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Resource details" className="details-tabs kub-tool-tabs" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowRight' ? (current + 1) % buttons.length : event.key === 'ArrowLeft' ? (current + buttons.length - 1) % buttons.length : -1;
        if (index >= 0) { event.preventDefault(); buttons[index]?.click(); buttons[index]?.focus(); }
      }}>
        {(tabs ?? [
          { id: 'overview', label: 'Overview' },
          { id: 'related', label: 'Related' },
          { id: 'events', label: 'Events' },
          { id: 'yaml', label: 'YAML' },
        ]).map(({ id: tab, label }) => (
          <button
            key={tab}
            role="tab"
            id={`${tabPrefix}-${tab}`}
            aria-controls={`${tabPrefix}-panel`}
            tabIndex={rightTab === tab ? 0 : -1}
            aria-selected={rightTab === tab}
            onClick={() => setTab(tab)}
            className="details-tab kub-tool-tab"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
