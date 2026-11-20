import { parseDocument } from 'yaml';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Code2, LoaderCircle, SlidersHorizontal } from 'lucide-react';
import { newResourceTemplate, updateNewResourceIdentity, validateNewResource, type NewResourceType } from '../../core/resources/new_resource';
import { apiVersionFor } from '../../core/resources/resource_types';
import {
  readManifestObject,
  readMetadataEntries,
  updateManifestMetadataPairs,
  validateKeyValueEntries,
  type CreatorMode,
  type KeyValueEntry,
} from '../../core/resources/creators';
import { useClusterStore } from '../../state/cluster_store';
import { k8s } from '../../providers/k8s_provider';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Input, Label } from '../ui/Input';
import { CodeEditor } from '../ui/CodeEditor';
import { resolveResourceCreator } from './new-resource/registry';
import { MetadataExtrasSection, NamespaceFieldInput } from './new-resource/SharedFormParts';
import './new-resource/new-resource.css';

export function NewResourceDialog({ open, type, context, defaultNs, onClose, onCreate }: {
  open: boolean; type: NewResourceType; context: string | null; defaultNs: string;
  onClose: () => void; onCreate: (object: Record<string, any>, manifest: string) => Promise<void>;
}) {
  const id = useId();
  const availableNamespaces = useClusterStore((s) => s.availableNamespaces);
  const creator = useMemo(() => resolveResourceCreator(type), [type.group, type.kind]);

  const [mode, setMode] = useState<CreatorMode>(creator ? 'form' : 'yaml');
  const [manifest, setManifest] = useState('');
  const [formState, setFormState] = useState<any>(null);
  const [labels, setLabels] = useState<KeyValueEntry[]>([]);
  const [annotations, setAnnotations] = useState<KeyValueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modeSwitchError, setModeSwitchError] = useState('');
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!open) return;
    const initialManifest = newResourceTemplate(type, `my-${type.kind.toLowerCase()}`, defaultNs);
    setManifest(initialManifest);
    setError('');
    setModeSwitchError('');
    if (creator) {
      const parsed = readManifestObject(initialManifest);
      if (parsed.ok) {
        setFormState(creator.model.fromObject(parsed.object, type));
        setLabels(readMetadataEntries(parsed.object, 'labels'));
        setAnnotations(readMetadataEntries(parsed.object, 'annotations'));
        setMode('form');
        return;
      }
    }
    setFormState(null);
    setLabels([]);
    setAnnotations([]);
    setMode('yaml');
  }, [open, type.kind, type.group, type.version, type.namespaced, defaultNs, creator]);

  const manifestValidation = useMemo(() => {
    try { return { object: validateNewResource(manifest, type), message: '' }; }
    catch (validationError) { return { object: undefined, message: validationError instanceof Error ? validationError.message : String(validationError) }; }
  }, [manifest, type.kind, type.group, type.version, type.namespaced]);

  const formValidationMessage = useMemo(() => {
    if (mode !== 'form' || !creator || formState === null) return '';
    const labelErr = validateKeyValueEntries(labels, 'Labels');
    if (labelErr) return labelErr;
    const annotationErr = validateKeyValueEntries(annotations, 'Annotations');
    if (annotationErr) return annotationErr;
    return creator.model.validate(formState, type);
  }, [mode, creator, formState, labels, annotations, type]);

  const validationMessage = formValidationMessage || manifestValidation.message;
  const canSubmit = !busy && !!manifestValidation.object && !formValidationMessage && !!context;

  const metadata = useMemo(() => {
    try { return parseDocument(manifest).toJS({ maxAliasCount: 50 })?.metadata; }
    catch { return undefined; }
  }, [manifest]);

  const changeIdentity = (key: 'name' | 'namespace', value: string) => {
    try {
      setManifest(updateNewResourceIdentity(
        manifest,
        key === 'name' ? value : metadata?.name ?? '',
        key === 'namespace' ? value : metadata?.namespace ?? '',
        type.namespaced,
      ));
      setError('');
    } catch (identityError) {
      setError(identityError instanceof Error ? identityError.message : String(identityError));
    }
  };

  const handleFormChange = (nextState: any) => {
    setFormState(nextState);
    setError('');
    setModeSwitchError('');
    if (!creator) return;
    try {
      const beforeParsed = readManifestObject(manifest);
      const nextManifest = creator.model.applyToManifest(manifest, nextState, type);
      setManifest(nextManifest);
      // Keep shared Labels/Annotations synced if the creator itself writes metadata labels (e.g. Namespace PSS).
      const afterParsed = readManifestObject(nextManifest);
      if (beforeParsed.ok && afterParsed.ok) {
        if (JSON.stringify(beforeParsed.object?.metadata?.labels ?? null) !== JSON.stringify(afterParsed.object?.metadata?.labels ?? null)) {
          setLabels(readMetadataEntries(afterParsed.object, 'labels'));
        }
        if (JSON.stringify(beforeParsed.object?.metadata?.annotations ?? null) !== JSON.stringify(afterParsed.object?.metadata?.annotations ?? null)) {
          setAnnotations(readMetadataEntries(afterParsed.object, 'annotations'));
        }
      }
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    }
  };

  const handleMetadataChange = (nextLabels: KeyValueEntry[], nextAnnotations: KeyValueEntry[]) => {
    setLabels(nextLabels);
    setAnnotations(nextAnnotations);
    setError('');
    try {
      const nextManifest = updateManifestMetadataPairs(manifest, nextLabels, nextAnnotations);
      setManifest(nextManifest);
      if (creator?.model.syncOnMetadataChange) {
        const parsed = readManifestObject(nextManifest);
        if (parsed.ok) setFormState(creator.model.fromObject(parsed.object, type));
      }
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    }
  };

  const switchMode = (nextMode: CreatorMode) => {
    if (nextMode === mode || !creator) return;
    if (nextMode === 'yaml') {
      setModeSwitchError('');
      setMode('yaml');
      return;
    }
    const parsed = readManifestObject(manifest);
    if (!parsed.ok) {
      setModeSwitchError(`Fix YAML syntax before switching to Form mode: ${parsed.error}`);
      return;
    }
    const expectedApi = apiVersionFor(type);
    if (parsed.object.kind !== type.kind || parsed.object.apiVersion !== expectedApi) {
      setModeSwitchError(`Expected apiVersion "${expectedApi}" and kind "${type.kind}" before switching to Form mode.`);
      return;
    }
    setFormState(creator.model.fromObject(parsed.object, type));
    setLabels(readMetadataEntries(parsed.object, 'labels'));
    setAnnotations(readMetadataEntries(parsed.object, 'annotations'));
    setModeSwitchError('');
    setError('');
    setMode('form');
  };

  const submit = async () => {
    if (submitting.current || !canSubmit || !manifestValidation.object || !context) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCreate(manifestValidation.object, manifest); }
    catch (submitError) {
      if ((submitError as { code?: string }).code !== 'cancelled') {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    } finally { submitting.current = false; setBusy(false); }
  };

  const ActiveForm = creator?.Form;

  return (
    <Modal
      open={open && !busy}
      onClose={() => { if (!busy) onClose(); }}
      width={760}
      title={`New ${type.kind}`}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
            {busy ? 'Waiting for confirmation…' : k8s.demo ? 'Create (demo)' : 'Review & create'}
          </Button>
        </>
      }
    >
      <div className="nr-shell">
        <div className="nr-header-bar">
          <div className="nr-context-meta">
            <p className="text-xs text-[var(--text-secondary)] break-words">
              Context: <strong className="font-mono text-[var(--text-primary)]">{context}</strong> · {type.namespaced ? 'Namespaced resource' : 'Cluster-scoped resource'}
            </p>
            {creator && mode === 'form' && (
              <p className="text-xs text-[var(--text-muted)]">{creator.model.description}</p>
            )}
          </div>
          {creator ? (
            <div role="group" aria-label="Creation mode" className="nr-mode-switch">
              <button
                type="button"
                aria-pressed={mode === 'form'}
                disabled={busy}
                className="nr-mode-btn"
                onClick={() => switchMode('form')}
              >
                <SlidersHorizontal size="calc(12px * var(--ui-factor))" aria-hidden="true" />
                Form
              </button>
              <button
                type="button"
                aria-pressed={mode === 'yaml'}
                disabled={busy}
                className="nr-mode-btn"
                onClick={() => switchMode('yaml')}
              >
                <Code2 size="calc(12px * var(--ui-factor))" aria-hidden="true" />
                YAML
              </button>
            </div>
          ) : (
            <Badge size="xs" tone="neutral">YAML manifest</Badge>
          )}
        </div>

        {modeSwitchError && (
          <p role="alert" className="text-xs text-[var(--status-warn)] break-words">{modeSwitchError}</p>
        )}

        <div className={`grid gap-3 ${type.namespaced ? 'sm:grid-cols-2' : ''}`}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              mono
              value={typeof metadata?.name === 'string' ? metadata.name : ''}
              disabled={busy || !metadata}
              onChange={(event) => changeIdentity('name', event.target.value)}
              placeholder="Set metadata.name in the manifest"
            />
          </div>
          {type.namespaced && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-namespace`}>Namespace</Label>
              <NamespaceFieldInput
                id={`${id}-namespace`}
                value={typeof metadata?.namespace === 'string' ? metadata.namespace : ''}
                namespaces={availableNamespaces}
                disabled={busy || !metadata}
                onChange={(value) => changeIdentity('namespace', value)}
                placeholder="Set metadata.namespace in the manifest"
              />
            </div>
          )}
        </div>

        {mode === 'form' && ActiveForm && formState !== null ? (
          <div className="flex flex-col gap-3 min-w-0">
            <ActiveForm
              state={formState}
              type={type}
              disabled={busy}
              onChange={handleFormChange}
            />
            <MetadataExtrasSection
              labels={labels}
              annotations={annotations}
              defaultOpen={creator?.model.defaultMetadataOpen ?? false}
              disabled={busy}
              onChangeLabels={(next) => handleMetadataChange(next, annotations)}
              onChangeAnnotations={(next) => handleMetadataChange(labels, next)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-manifest`}>Manifest · YAML</Label>
            <CodeEditor
              id={`${id}-manifest`}
              ariaLabel="Manifest · YAML"
              aria-describedby={`${id}-help${validationMessage ? ` ${id}-validation` : ''}`}
              aria-invalid={!!validationMessage}
              value={manifest}
              onChange={(value) => { setManifest(value); setError(''); setModeSwitchError(''); }}
              readOnly={busy}
              language="yaml"
              height="min(42vh, 380px)"
            />
          </div>
        )}

        {validationMessage && (
          <p id={`${id}-validation`} role="status" className="text-xs text-[var(--status-warn)] whitespace-pre-wrap break-words">
            {validationMessage}
          </p>
        )}
        {error && (
          <p ref={errorRef} role="alert" tabIndex={-1} className="text-xs text-[var(--status-danger)] break-words">
            {error}
          </p>
        )}
        <p id={`${id}-help`} className="text-xs text-[var(--text-secondary)]">
          {k8s.demo
            ? 'Demo mode · the object is stored in this session.'
            : 'Review the complete manifest before confirming. An existing object with the same name will not be overwritten.'}
        </p>
      </div>
    </Modal>
  );
}
