import React, { Suspense, lazy, useState } from 'react';
import { ArrowRightLeft, Boxes, Copy, FileText, Loader2, Terminal, Trash2, X, ExternalLink } from 'lucide-react';
import { useResourceStore } from '../../state/resource_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { KIND_ICONS } from '../../core/perspectives';
import { StatusBadge } from '../k8s/StatusBadge';
import { IconButton, Button, Tooltip } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { PFDialog } from '../dialogs/PFDialog';
import { toast } from '../../state/notifications_store';
import type { RightTab as RightTabT } from '../../state/ui_store';
import { cx } from '../../core/utils/cx';
import type { ResourceItem } from '../../types/k8s';

/* Monaco is heavy — split it out of the initial chunk. */
const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));

export const InspectorPanel: React.FC = () => {
  const selectedItem = useResourceStore((s) => s.selectedItem);
  const updateItem = useResourceStore((s) => s.updateItem);
  const deleteItem = useResourceStore((s) => s.deleteItem);
  const { rightTab, setRightTab, toggleInspector, openDock } = useUiStore();

  const [pfOpen, setPfOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  if (!selectedItem) {
    /* Frame stays intact even with no selection — the X button is always alive. */
    return (
      <div className="h-full flex flex-col bg-[var(--bg-canvas)] min-h-0">
        <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="h-9 flex items-center gap-2 px-2.5">
            <Boxes size={14} strokeWidth={1.75} className="text-[var(--text-muted)] shrink-0" />
            <span className="text-[12px] font-medium text-[var(--text-secondary)] flex-1">Details</span>
            <Tooltip label="Close panel" delay={400}>
              <IconButton icon={X} size="sm" onClick={toggleInspector} aria-label="Close" />
            </Tooltip>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-center max-w-[260px] px-6">
            <Boxes size={32} strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-3" />
            <div className="text-xs font-medium text-[var(--text-primary)]">No resource selected</div>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">
              Click a row in the table to inspect it here. Double-click opens the YAML editor.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const item = selectedItem;
  const Icon = KIND_ICONS[item.kind];
  const isYaml = rightTab === 'yaml';

  const copyYaml = async () => {
    if (!item.rawYaml) return;
    try {
      await navigator.clipboard.writeText(item.rawYaml);
      toast.success('YAML copied');
    } catch {
      toast.error('Clipboard unavailable');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] min-h-0">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="h-9 flex items-center gap-2 px-2.5">
          <Icon size={14} strokeWidth={1.75} className="text-[var(--text-secondary)] shrink-0" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[12px] font-mono font-medium text-[var(--text-primary)] truncate">{item.name}</div>
            <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
              <span>{item.kind}</span>
              {item.namespace && <><span>·</span><span className="truncate">{item.namespace}</span></>}
            </div>
          </div>
          <Tooltip label="Copy YAML" delay={400}>
            <IconButton icon={Copy} size="sm" onClick={copyYaml} aria-label="Copy YAML" />
          </Tooltip>
          <Tooltip label="Open in Dedicated Tab" delay={400}>
            <IconButton icon={ExternalLink} size="sm" onClick={() => useWorkspaceStore.getState().openResourceDetail(item)} aria-label="Open in Tab" />
          </Tooltip>
          <Tooltip label="Delete…" delay={400}>
            <IconButton icon={Trash2} size="sm" danger onClick={() => setConfirmDel(true)} aria-label="Delete" />
          </Tooltip>
          <Tooltip label="Close panel" delay={400}>
            <IconButton icon={X} size="sm" onClick={toggleInspector} aria-label="Close" />
          </Tooltip>
        </div>

        {/* Tabs */}
        <div className="flex items-end px-2 gap-1">
          <InspectorTab id="overview" label="Overview" active={rightTab} onClick={setRightTab} />
          <InspectorTab id="yaml" label="YAML" active={rightTab} onClick={setRightTab} />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {isYaml ? (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center gap-2 text-[11px] text-[var(--text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading editor…
              </div>
            }
          >
            <YamlEditor
              item={item}
              onApply={(yaml) => {
                updateItem(item.kind, item.uid, { rawYaml: yaml });
                toast.success('Manifest applied (demo)', `${item.kind}/${item.name}`);
              }}
            />
          </Suspense>
        ) : (
          <Overview item={item} onPortForward={() => setPfOpen(true)} onLogs={() => openDock('logs')} onTerminal={() => openDock('terminal')} />
        )}
      </div>

      <PFDialog item={pfOpen ? item : null} onClose={() => setPfOpen(false)} />

      <Modal
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title={`Delete ${item.kind.toLowerCase()}`}
        width={400}
        footer={
          <>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                deleteItem(item.kind, item.uid);
                toast.warn('Deleted (demo)', `${item.kind}/${item.name}`);
                setConfirmDel(false);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
          Delete <span className="font-mono text-[var(--text-primary)]">{item.name}</span>
          {item.namespace ? <> from <span className="font-mono">{item.namespace}</span></> : null}? This cannot be undone.
        </p>
      </Modal>
    </div>
  );
};

function InspectorTab({ id, label, active, onClick }: { id: RightTabT; label: string; active: RightTabT | string; onClick: (id: RightTabT) => void }) {
  const isActive = active === id;
  return (
    <button
      onClick={() => onClick(id)}
      className={cx(
        'relative px-3 h-[26px] text-[11px] font-medium transition-colors',
        isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      )}
    >
      {label}
      {id === 'yaml' && <span className="ml-1.5 text-[9px] font-mono opacity-60">⌘S</span>}
      {isActive && <span className="absolute inset-x-2 bottom-0 h-[2px] bg-[var(--accent)] rounded-t" />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function Overview({ item, onPortForward, onLogs, onTerminal }: { item: ResourceItem; onPortForward: () => void; onLogs: () => void; onTerminal: () => void }) {
  const isPod = item.kind === 'Pod';
  const isWorkload = ['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind);
  const isSvc = item.kind === 'Service';
  const isSecret = item.kind === 'Secret';
  const [reveal, setReveal] = useState(false);

  return (
    <div className="h-full overflow-y-auto kubiki-scrollbar p-3 flex flex-col gap-3">
      {/* Status strip */}
      <div className="flex items-center gap-2 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-3 py-2">
        {item.status && <StatusBadge status={item.status} size="sm" />}
        {item.ready && <span className="font-mono text-[11px] text-[var(--text-primary)]">{item.ready}</span>}
        {item.kind === 'Pod' && !!item.restarts && (
          <span className={cx('text-[11px] font-mono', (item.restarts ?? 0) > 10 ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]')}>
            {item.restarts} restarts
          </span>
        )}
        <div className="flex-1" />
        {isPod && (
          <Tooltip label="Stream logs" delay={400}>
            <IconButton icon={FileText} size="sm" onClick={onLogs} aria-label="Logs" />
          </Tooltip>
        )}
        {isPod && (
          <Tooltip label="Terminal" delay={400}>
            <IconButton icon={Terminal} size="sm" onClick={onTerminal} aria-label="Terminal" />
          </Tooltip>
        )}
        {(isPod || isSvc) && (
          <Tooltip label="Port-forward…" delay={400}>
            <IconButton icon={ArrowRightLeft} size="sm" onClick={onPortForward} aria-label="Port-forward" />
          </Tooltip>
        )}
      </div>

      {/* Metadata */}
      <Card title="Metadata">
        <MetaGrid
          rows={[
            ['Kind', item.kind],
            ['API version', item.apiVersion],
            ['Namespace', item.namespace ?? '(cluster-scoped)'],
            ['Age', item.age ?? '—'],
            ['IP', item.ip],
            ['Node', item.node],
            ['Image', isWorkload ? item.image : undefined],
            ['Type', item.serviceType],
            ['Cluster IP', item.clusterIP],
            ['Storage class', item.storageClass],
            ['Volume', item.volume],
            ['Role', item.nodeRoles],
            ['Version', item.nodeVersion],
            ['Hosts', item.ingressHosts],
          ]}
        />
      </Card>

      {/* Containers */}
      {isPod && !!item.containers?.length && (
        <Card title={`Containers (${item.containers.length})`}>
          <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
            {item.containers.map((c) => (
              <div key={c.name} className="flex items-center gap-2 py-1.5 text-[11px]">
                <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', c.ready ? 'bg-[var(--status-ok)]' : 'bg-[var(--status-danger)]')} />
                <span className="font-mono text-[var(--text-primary)] w-[90px] truncate">{c.name}</span>
                <span className="font-mono text-[10.5px] text-[var(--text-muted)] truncate flex-1" title={c.image}>{c.image}</span>
                <span className="font-mono text-[10.5px] text-[var(--text-secondary)] shrink-0">{c.port}</span>
                {c.restarts > 0 && <span className="font-mono text-[10.5px] text-[var(--status-warn)] shrink-0">{c.restarts}×</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Secret values */}
      {isSecret && (
        <Card title="Data (masked)">
          <div className="flex items-center justify-between gap-2 py-1">
            <span className="font-mono text-[11px] text-[var(--text-primary)]">
              {reveal ? 's3cr3t-do-not-share-value' : '••••••••••••••••'}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setReveal(!reveal)}>
              {reveal ? 'Hide values' : 'Reveal (demo)'}
            </Button>
          </div>
        </Card>
      )}

      {/* Labels */}
      <Card title="Labels">
        {item.labels && Object.keys(item.labels).length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(item.labels).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-[4px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] pl-1.5 pr-1.5 py-[2px] text-[10px] max-w-full">
                <span className="text-[var(--text-muted)]">{k}:</span>
                <span className="font-mono text-[var(--text-primary)]">{v}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">No labels</span>
        )}
      </Card>

      <Card title="Actions">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onLogs} disabled={!isPod}>
            <FileText size={12} /> Logs
          </Button>
          <Button size="sm" onClick={onTerminal} disabled={!isPod}>
            <Terminal size={12} /> Terminal
          </Button>
          <Button size="sm" onClick={onPortForward} disabled={!isPod && !isSvc}>
            <ArrowRightLeft size={12} /> Port-forward
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]/30 overflow-hidden">
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">{title}</div>
      <div className="px-3 pb-2.5">{children}</div>
    </section>
  );
}

function MetaGrid({ rows }: { rows: Array<[string, string | undefined]> }) {
  const visible = rows.filter(([, v]) => v !== undefined && v !== '');
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[11px]">
      {visible.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-[var(--text-muted)] whitespace-nowrap py-[1px]">{k}</dt>
          <dd className={cx('text-[var(--text-primary)] min-w-0 truncate py-[1px]', k !== 'Kind' && k !== 'Namespace' && 'font-mono text-[10.5px]')} title={v}>
            {v}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
