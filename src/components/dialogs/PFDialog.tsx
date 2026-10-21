import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { usePfStore } from '../../state/pf_store';
import { useDockStore } from '../../state/dock_store';
import { useClusterStore } from '../../state/cluster_store';
import { k8s } from '../../providers/k8s_provider';
import { startPortForward, openForwardUrl } from '../../providers/port_forward';
import { normalizeK8sError, errorHint } from '../../providers/errors';
import { resourceRef } from '../../core/resources/identity';
import { toast } from '../../state/notifications_store';
import type { ResourceItem } from '../../types/k8s';

export function PFDialog({ item, onClose, initialRemotePort }: { item: ResourceItem | null; onClose: () => void; initialRemotePort?: number }) {
  const context = useClusterStore(state => state.currentContext);
  const openedContext = useRef(context);
  useEffect(() => { if (context !== openedContext.current) { controller.current?.abort(); onClose(); } }, [context]);
  const controller = useRef<AbortController | null>(null);
  const [remote, setRemote] = useState(''); const [local, setLocal] = useState('');
  const [browser, setBrowser] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const ports = useMemo(() => {
    const source = item?.kind === 'Service' ? item.raw?.spec?.ports ?? [] : (item?.raw?.spec?.containers ?? []).flatMap((c: any) => c.ports ?? []);
    return source.filter((p: any) => (p.protocol ?? 'TCP') === 'TCP').map((p: any) => ({ port: p.port ?? p.containerPort, name: p.name }));
  }, [item]);
  useEffect(() => {
    const suggested = Number(initialRemotePort ?? ports[0]?.port ?? item?.containers?.[0]?.port);
    setRemote(String(Number.isInteger(suggested) && suggested > 0 && suggested <= 65535 ? suggested : 80)); setLocal(''); setError(''); setBusy(false);
    return () => controller.current?.abort();
    // Status updates must not reset a user's draft or cancel an in-flight start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.uid, context, initialRemotePort]);
  if (!item) return null;
  const remoteInvalid = !/^\d+$/.test(remote) || +remote < 1 || +remote > 65535;
  const localInvalid = local !== '' && (!/^\d+$/.test(local) || +local < 0 || +local > 65535);
  const close = () => { controller.current?.abort(); onClose(); };
  const start = async () => {
    if (busy || remoteInvalid || localInvalid || !context || context !== openedContext.current) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError('');
    try {
      let session;
      if (k8s.demo) session = usePfStore.getState().add({ targetKind: item.kind, targetName: item.name, namespace: item.namespace ?? '-', remotePort: Number(remote), localPort: Number(local) || 0, openBrowser: false });
      else {
        const native = await startPortForward({ resource: resourceRef(context, item), remote_port: Number(remote), local_port: Number(local) || 0 }, abort.signal);
        if (abort.signal.aborted || useClusterStore.getState().currentContext !== context) return;
        session = usePfStore.getState().upsertLive(native);
      }
      useDockStore.getState().openPorts();
      toast.success(k8s.demo ? 'Demo tunnel created' : 'Port forward listening', `127.0.0.1:${session.localPort} → ${item.kind}/${item.name}:${remote}`);
      onClose();
      if (browser && !k8s.demo) void openForwardUrl(session.localPort).catch(failure => toast.warn('Tunnel is ready; browser could not open', String(failure)));
    } catch (failure) {
      if (!abort.signal.aborted) { const error = normalizeK8sError(failure, { operation: 'port_forward', context }); setError(`${error.message} ${errorHint(error)}`); }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  };
  return <Modal open onClose={close} width={460} title={<span className="flex items-center gap-2"><ArrowRightLeft size={14} />Create port-forward</span>}
    footer={<><Button onClick={close}>{busy ? 'Cancel start' : 'Cancel'}</Button><Button variant="primary" disabled={busy || remoteInvalid || localInvalid || !context} onClick={() => void start()}>{busy ? 'Connecting…' : 'Start forward'}</Button></>}>
    <div className="flex flex-col gap-3 text-xs">
      <div className="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"><p className="font-mono break-all">{item.kind}/{item.name}</p><p className="text-[var(--text-secondary)] mt-1">{context} · {item.namespace}</p></div>
      {ports.length > 0 && <label>Declared TCP ports<select aria-label="Declared TCP ports" className="ide-select w-full mt-1" value={ports.some((p: any) => String(p.port) === remote) ? remote : ''} disabled={busy} onChange={event => { if (event.target.value) setRemote(event.target.value); }}><option value="">Custom port</option>{ports.map((p: any, index: number) => <option key={index} value={p.port}>{p.name ? `${p.name} · ` : ''}{p.port}/TCP</option>)}</select></label>}
      <div className="grid grid-cols-2 gap-3"><div><Label>{item.kind === 'Service' ? 'Service port' : 'Pod port'}</Label><Input aria-label="Remote port" value={remote} disabled={busy} onChange={event => setRemote(event.target.value)} invalid={remoteInvalid} inputMode="numeric" autoFocus />{remoteInvalid && <p className="text-[var(--status-danger)]">1–65535</p>}</div><div><Label>Local port (0 = auto)</Label><Input aria-label="Local port" value={local} disabled={busy} onChange={event => setLocal(event.target.value)} invalid={localInvalid} placeholder="auto" inputMode="numeric" />{localInvalid && <p className="text-[var(--status-danger)]">0–65535 or empty</p>}</div></div>
      <label className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={browser} onChange={event => setBrowser(event.target.checked)} />Open HTTP URL after the tunnel is ready</label>
      <p className="text-[var(--text-secondary)]">{k8s.demo ? 'Demo only · simulated traffic, no listener is opened.' : 'TCP · listens on 127.0.0.1 only. An empty local port selects a free port.'}{item.kind === 'Service' && ' Service port is mapped to targetPort on a selected Running Pod; restart the tunnel if that Pod changes.'}</p>
      {error && <p role="alert" className="text-[var(--status-danger)] break-words">{error}</p>}
    </div>
  </Modal>;
}
