import { parseDocument } from 'yaml';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { newResourceTemplate, updateNewResourceIdentity, validateNewResource, type NewResourceType } from '../../core/resources/new_resource';
import { k8s } from '../../providers/k8s_provider';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';

export function NewResourceDialog({ open, type, context, defaultNs, onClose, onCreate }: {
  open: boolean; type: NewResourceType; context: string | null; defaultNs: string;
  onClose: () => void; onCreate: (object: Record<string, any>, manifest: string) => Promise<void>;
}) {
  const id = useId();
  const [manifest, setManifest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (open) {
      setManifest(newResourceTemplate(type, `my-${type.kind.toLowerCase()}`, defaultNs));
      setError('');
    }
  }, [open, type.kind, type.group, type.version, type.namespaced, defaultNs]);
  const validation = useMemo(() => {
    try { return { object: validateNewResource(manifest, type), message: '' }; }
    catch (error) { return { object: undefined, message: error instanceof Error ? error.message : String(error) }; }
  }, [manifest, type.kind, type.group, type.version, type.namespaced]);
  const metadata = useMemo(() => {
    try { return parseDocument(manifest).toJS({ maxAliasCount: 50 })?.metadata; }
    catch { return undefined; }
  }, [manifest]);
  const changeIdentity = (key: 'name' | 'namespace', value: string) => {
    try {
      setManifest(updateNewResourceIdentity(manifest, key === 'name' ? value : metadata?.name ?? '', key === 'namespace' ? value : metadata?.namespace ?? '', type.namespaced));
      setError('');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const submit = async () => {
    if (submitting.current || !validation.object || !context) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCreate(validation.object, manifest); }
    catch (error) {
      if ((error as { code?: string }).code !== 'cancelled') {
        setError(error instanceof Error ? error.message : String(error));
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    } finally { submitting.current = false; setBusy(false); }
  };
  return <Modal open={open} onClose={() => { if (!busy) onClose(); }} width={720} title={`New ${type.kind}`} footer={<>
    <Button disabled={busy} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={busy || !validation.object || !context} onClick={() => void submit()}>
      {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
      {busy ? 'Waiting for confirmation…' : k8s.demo ? 'Create (demo)' : 'Review & create'}
    </Button>
  </>}>
    <div className="flex flex-col gap-4">
      <p className="text-xs text-[var(--text-secondary)] break-words">Context: <strong className="font-mono text-[var(--text-primary)]">{context}</strong> · {type.namespaced ? 'Namespaced resource' : 'Cluster-scoped resource'}</p>
      <div className={`grid gap-3 ${type.namespaced ? 'sm:grid-cols-2' : ''}`}>
        <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-name`}>Name</Label><Input id={`${id}-name`} value={typeof metadata?.name === 'string' ? metadata.name : ''} disabled={busy || !metadata} onChange={event => changeIdentity('name', event.target.value)} placeholder="Set metadata.name in the manifest" /></div>
        {type.namespaced && <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-namespace`}>Namespace</Label><Input id={`${id}-namespace`} value={typeof metadata?.namespace === 'string' ? metadata.namespace : ''} disabled={busy || !metadata} onChange={event => changeIdentity('namespace', event.target.value)} placeholder="Set metadata.namespace in the manifest" /></div>}
      </div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-manifest`}>Manifest · YAML</Label>
        <textarea id={`${id}-manifest`} aria-describedby={`${id}-help${validation.message ? ` ${id}-validation` : ''}`} aria-invalid={!!validation.message} value={manifest} onChange={event => { setManifest(event.target.value);setError(''); }} disabled={busy} spellCheck={false} className="min-h-[min(38vh,360px)] resize-y bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded p-3 font-mono text-xs text-[var(--text-primary)] focus:outline-2 focus:outline-[var(--accent)] kubiki-scrollbar" />
        {validation.message && <p id={`${id}-validation`} role="status" className="text-xs text-[var(--status-warn)] whitespace-pre-wrap break-words">{validation.message}</p>}
      </div>
      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-xs text-[var(--status-danger)] break-words">{error}</p>}
      <p id={`${id}-help`} className="text-xs text-[var(--text-secondary)]">{k8s.demo ? 'Demo mode · the object is stored in this session.' : 'Review the complete manifest before confirming. An existing object with the same name will not be overwritten.'}</p>
    </div>
  </Modal>;
}
