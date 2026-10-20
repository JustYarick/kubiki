import { TerminalFontSettings } from './TerminalFontSettings';
import React from 'react';
import { Cpu, KeyRound, Layout, Maximize2, Minimize2, Monitor, RotateCcw, Server } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useUiStore } from '../state/ui_store';
import { toast } from '../state/notifications_store';
import { useClusterStore } from '../state/cluster_store';
import { cx } from '../core/utils/cx';
import { APPEARANCE_LIMITS, DEFAULT_APPEARANCE } from '../core/appearance';

function Row({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[length:calc(12px*var(--ui-factor))] text-[var(--text-primary)]">{title}</div>
        {description && <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mt-0.5 leading-snug">{description}</div>}
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
      <Icon size="calc(13px * var(--ui-factor))" className="text-[var(--text-muted)]" />
      <span className="text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)]">{children}</span>
    </div>
  );
}

export const SettingsDialog: React.FC = () => {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const { density, setDensity, resetLayout, uiScale, setUiScale, editorFontSize, setEditorFontSize, terminalFontSize, setTerminalFontSize, resetAppearance } = useUiStore();
  const { currentContext, clusterVersion } = useClusterStore();

  if (!open) return null;

  return (
    <Modal open onClose={() => setOpen(false)} width={520} title="Settings">
      <div className="flex flex-col px-1">
        <SectionTitle icon={Monitor}>Appearance</SectionTitle>
        <Row title="Interface scale" description="Scales text, icons and controls. 100% uses a 13px base UI font.">
          <div className="flex items-center gap-2">
            <input aria-label="Interface scale" type="range" min={APPEARANCE_LIMITS.uiScale[0]} max={APPEARANCE_LIMITS.uiScale[1]} step={5} value={uiScale} onChange={(event) => setUiScale(Number(event.target.value))} className="w-28 accent-[var(--accent)]" />
            <output className="w-12 text-right font-mono text-xs">{uiScale}%</output>
          </div>
        </Row>
        <div className="flex flex-wrap gap-1 pb-2" aria-label="Interface scale presets">{[100, 110, 125, 150, 175, 200].map((scale) => <button key={scale} aria-label={`Set interface scale to ${scale}%`} aria-pressed={uiScale === scale} onClick={() => setUiScale(scale)} className={cx('px-2 py-1 rounded border text-xs', uiScale === scale ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]')}>{scale}%{scale === DEFAULT_APPEARANCE.uiScale ? ' · default' : ''}</button>)}</div>
        <Row title="YAML editor font" description="Independent of the interface scale; applies to open editors.">
          <input aria-label="YAML editor font size" type="number" min={10} max={24} value={editorFontSize} onChange={(event) => { if (event.target.value) setEditorFontSize(Number(event.target.value)); }} className="ide-select w-20" />
        </Row>
        <Row title="Terminal font" description="Independent of the interface scale; preserves open sessions.">
          <input aria-label="Terminal font size" type="number" min={10} max={24} value={terminalFontSize} onChange={(event) => { if (event.target.value) setTerminalFontSize(Number(event.target.value)); }} className="ide-select w-20" />
        </Row>
        <TerminalFontSettings />
        <Row title="Reset appearance" description="Restore 110% scale, 14px editor/terminal text and default terminal typeface.">
          <Button size="sm" onClick={resetAppearance} aria-label="Reset appearance"><RotateCcw size="calc(12px * var(--ui-factor))" /> Reset</Button>
        </Row>
        <Row title="Row density" description="Affects table rows across all resource views.">
          <div className="flex items-center rounded-[calc(5px*var(--ui-factor))] border border-[var(--border-default)] overflow-hidden">
            {(['compact', 'comfortable'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                className={cx(
                  'flex items-center gap-1.5 h-[calc(26px*var(--ui-factor))] px-2.5 text-[length:calc(11px*var(--ui-factor))] transition-colors capitalize',
                  density === d ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                {d === 'compact' ? <Minimize2 size="calc(12px * var(--ui-factor))" /> : <Maximize2 size="calc(12px * var(--ui-factor))" />}
                {d}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Theme" description="Dark is shipped; light theme lands in phase UI-10.">
          <div className="flex items-center rounded-[calc(5px*var(--ui-factor))] border border-[var(--border-default)] overflow-hidden opacity-50">
            <span className="flex items-center gap-1.5 h-[calc(26px*var(--ui-factor))] px-2.5 text-[length:calc(11px*var(--ui-factor))] bg-[var(--bg-accented)] text-[var(--text-primary)]">
              <Maximize2 size="calc(12px * var(--ui-factor))" className="opacity-0" />
              Dark
            </span>
            <span className="flex items-center h-[calc(26px*var(--ui-factor))] px-2.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-disabled)]">Light</span>
          </div>
        </Row>

        <Divider />

        <SectionTitle icon={Layout}>Panels</SectionTitle>
        <Row title="Reset layout" description="Restore default sidebar, details and bottom panel dimensions.">
          <Button
            size="sm"
            onClick={() => {
              resetLayout();
              toast.success('Layout restored to defaults');
            }}
          >
            <RotateCcw size="calc(12px * var(--ui-factor))" /> Reset
          </Button>
        </Row>

        <Divider />

        <SectionTitle icon={Server}>Cluster</SectionTitle>
        <Row title="Current context" description="Managed from the title bar dropdown.">
          <Input value={currentContext ?? '—'} readOnly className="w-[calc(180px*var(--ui-factor))]" />
        </Row>
        <Row title="Server version" description="Reported by the API server of the selected context.">
          <Input value={clusterVersion ? clusterVersion.replace(/^v?/, 'v') : '—'} readOnly className="w-[calc(180px*var(--ui-factor))]" />
        </Row>
        <Row title="Kubeconfig" description="Read-only in this milestone.">
          <Input value="~/.kube/config" readOnly className="w-[calc(180px*var(--ui-factor))]" />
        </Row>

        <Divider />

        <SectionTitle icon={Cpu}>About</SectionTitle>
        <div className="flex items-start gap-2 py-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] leading-relaxed">
          <KeyRound size="calc(13px * var(--ui-factor))" className="text-[var(--text-muted)] mt-0.5" />
          <span>
            Kubiki 0.1.0 — early alpha Kubernetes IDE. Live resource snapshots and log tails are connected;
            watch streams, interactive terminals and port forwarding are still in development. Apache License 2.0.
          </span>
        </div>
      </div>
    </Modal>
  );
};
