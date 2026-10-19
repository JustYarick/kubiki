import { useEffect, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { usePfStore } from '../../state/pf_store';
import { useUiStore } from '../../state/ui_store';
import { toast } from '../../state/notifications_store';
import type { ResourceItem } from '../../types/k8s';

/** Port-forward launcher for a pod/service/ingress-like item. */
export function PFDialog({ item, onClose }: { item: ResourceItem | null; onClose: () => void }) {
  const add = usePfStore((s) => s.add);
  const openDock = useUiStore((s) => s.openDock);

  const suggested = item?.containers?.[0]?.port ?? item?.ready?.split(':')[0]?.split('/')[0] ?? '80';
  const [remote, setRemote] = useState('');
  const [local, setLocal] = useState('');
  const [browser, setBrowser] = useState(true);

  useEffect(() => {
    if (item) {
      setRemote(String(suggested ?? '80'));
      setLocal('');
    }
  }, [item?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;

  const remoteInvalid = !/^\d+$/.test(remote) || +remote < 1 || +remote > 65535;
  const localInvalid = local !== '' && (!/^\d+$/.test(local) || +local < 1024 || +local > 65534);

  const start = () => {
    const session = add({
      targetKind: item.kind,
      targetName: item.name,
      namespace: item.namespace ?? '-',
      remotePort: Number(remote),
      localPort: local === '' ? 0 : Number(local),
      openBrowser: browser,
    });
    openDock('ports');
    toast.success(
      `Port-forward started`,
      `${session.targetKind}/${session.targetName} → localhost:${session.localPort}${browser ? ' (browser would open)' : ''}`
    );
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={
        <span className="flex items-center gap-2">
          <ArrowRightLeft size={14} className="text-[var(--accent)]" />
          Create port-forward
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={remoteInvalid || localInvalid} onClick={start}>
            Start forward
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
          <div className="text-[12px] font-mono text-[var(--text-primary)]">
            {item.kind}/{item.name}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">namespace: {item.namespace ?? '-'}</div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Remote port</Label>
            <Input
              value={remote}
              onChange={(e) => setRemote(e.target.value.replace(/[^\d]/g, ''))}
              invalid={remoteInvalid}
              placeholder="80"
              autoFocus
            />
            {remoteInvalid && <span className="text-[10px] text-[var(--status-danger)]">1–65535</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Local port (0 = auto)</Label>
            <Input
              value={local}
              onChange={(e) => setLocal(e.target.value.replace(/[^\d]/g, ''))}
              invalid={localInvalid}
              placeholder="auto"
            />
            {localInvalid && <span className="text-[10px] text-[var(--status-danger)]">1024–65534 or empty</span>}
          </div>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={browser}
            onChange={(e) => setBrowser(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Open browser after forward is ready
        </label>

        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          Demo mode: a session will appear in the Ports panel with simulated traffic. Real port-forwarding is wired in phase UI-4.
        </p>
      </div>
    </Modal>
  );
}
