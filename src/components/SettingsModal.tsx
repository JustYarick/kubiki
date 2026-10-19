import React from 'react';
import { Cpu, KeyRound, Layout, Maximize2, Minimize2, Monitor, RotateCcw, Server } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useUiStore } from '../state/ui_store';
import { toast } from '../state/notifications_store';
import { useClusterStore } from '../state/cluster_store';
import { cx } from '../core/utils/cx';

function Row({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[12px] text-[var(--text-primary)]">{title}</div>
        {description && <div className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-[var(--border-subtle)] my-1" />;
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Layout; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2 pb-1">
      <Icon size={13} className="text-[var(--text-muted)]" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)]">{children}</span>
    </div>
  );
}

export const SettingsDialog: React.FC = () => {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const { density, setDensity, resetLayout } = useUiStore();
  const { currentContext, clusterVersion } = useClusterStore();

  if (!open) return null;

  return (
    <Modal open onClose={() => setOpen(false)} width={520} title="Settings">
      <div className="flex flex-col px-1">
        <SectionTitle icon={Monitor}>Appearance</SectionTitle>
        <Row title="Row density" description="Affects table rows across all resource views.">
          <div className="flex items-center rounded-[5px] border border-[var(--border-default)] overflow-hidden">
            {(['compact', 'comfortable'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                className={cx(
                  'flex items-center gap-1.5 h-[26px] px-2.5 text-[11px] transition-colors capitalize',
                  density === d ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                {d === 'compact' ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                {d}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Theme" description="Dark is shipped; light theme lands in phase UI-10.">
          <div className="flex items-center rounded-[5px] border border-[var(--border-default)] overflow-hidden opacity-50">
            <span className="flex items-center gap-1.5 h-[26px] px-2.5 text-[11px] bg-[var(--bg-accented)] text-[var(--text-primary)]">
              <Maximize2 size={12} className="opacity-0" />
              Dark
            </span>
            <span className="flex items-center h-[26px] px-2.5 text-[11px] text-[var(--text-disabled)]">Light</span>
          </div>
        </Row>

        <Divider />

        <SectionTitle icon={Layout}>Panels</SectionTitle>
        <Row title="Reset layout" description="Restore sidebar 246px · details 360px · dock 260px.">
          <Button
            size="sm"
            onClick={() => {
              resetLayout();
              toast.success('Layout restored to defaults');
            }}
          >
            <RotateCcw size={12} /> Reset
          </Button>
        </Row>

        <Divider />

        <SectionTitle icon={Server}>Cluster</SectionTitle>
        <Row title="Current context" description="Managed from the title bar dropdown.">
          <Input value={currentContext ?? '—'} readOnly className="w-[180px]" />
        </Row>
        <Row title="Server version" description="Demo mock cluster; connection via Rust core (phase UI-4).">
          <Input value={clusterVersion ? `v${clusterVersion}` : '—'} readOnly className="w-[180px]" />
        </Row>
        <Row title="Kubeconfig" description="Read-only in this milestone.">
          <Input value="~/.kube/config" readOnly className="w-[180px]" />
        </Row>

        <Divider />

        <SectionTitle icon={Cpu}>About</SectionTitle>
        <div className="flex items-start gap-2 py-2 text-[11px] text-[var(--text-secondary)] leading-relaxed">
          <KeyRound size={13} className="text-[var(--text-muted)] mt-0.5" />
          <span>
            Kubiki 0.1.0-canary — Kubernetes IDE demo. UI runs on demo data; the Rust headless core (watchers, logs, exec,
            port-forward, Helm) connects in phase UI-4.
          </span>
        </div>
      </div>
    </Modal>
  );
};
