import { useId, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Tags, Trash2, Upload } from 'lucide-react';
import {
  nextEntryId,
  PORT_PROTOCOLS,
  IMAGE_PULL_POLICIES,
  type ContainerDraft,
  type ContainerPortDraft,
  type ImagePullPolicy,
  type KeyValueEntry,
  type PortProtocol,
} from '../../../core/resources/creators';
import { Button, IconButton } from '../../ui/Button';
import { Popover } from '../../ui/Dropdown';
import { Input, Textarea } from '../../ui/Input';
import { Field, FieldGroup, SectionCard } from '../../ui/LayoutPrimitives';
import { Select } from '../../ui/Select';
import { Badge } from '../../ui/Badge';
import { toast } from '../../../state/notifications_store';

const MAX_FILE_BYTES = 1024 * 1024;

function encodeUint8ArrayBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export interface LoadedFilePayload {
  filename: string;
  content: string;
  mode: 'text' | 'base64';
}

/** Reads a local file (<= 1 MiB) as UTF-8 text or base64 binary fallback. */
export function FileLoadButton({
  label = 'Load file',
  accept,
  disabled,
  allowBinary = false,
  onLoad,
}: {
  label?: string;
  accept?: string;
  disabled?: boolean;
  allowBinary?: boolean;
  onLoad: (file: LoadedFilePayload) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error('File exceeds 1 MiB', `${file.name} is larger than the Kubernetes 1 MiB object limit.`);
      return;
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      onLoad({ filename: file.name, content: text, mode: 'text' });
    } catch {
      if (allowBinary) {
        onLoad({ filename: file.name, content: encodeUint8ArrayBase64(bytes), mode: 'base64' });
      } else {
        toast.error('Binary file not supported here', `${file.name} is not valid UTF-8 text.`);
      }
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void handleFile(file);
        }}
      />
      <Button
        size="xs"
        variant="secondary"
        icon={Upload}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}

/**
 * Literal-safe Namespace input with an optional cluster namespace picker popover.
 * Keeps standard `<input>` semantics so users can type new or existing namespaces freely.
 */
export function NamespaceFieldInput({
  id,
  value,
  namespaces,
  disabled,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  namespaces: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const options = namespaces.filter((ns) => ns && ns !== 'all');
  const trailing = options.length > 0 && !disabled ? (
    <Popover
      width={240}
      align="end"
      trigger={({ open }) => (
        <button
          type="button"
          aria-label="Choose existing namespace"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Pick an existing namespace"
          className="flex items-center justify-center h-[var(--control-h-xs)] w-[var(--control-h-xs)] rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          <ChevronDown size="calc(12px * var(--ui-factor))" />
        </button>
      )}
    >
      {(close) => (
        <div role="listbox" aria-label="Available namespaces" className="max-h-56 overflow-y-auto kubiki-scrollbar py-1">
          {options.map((ns) => (
            <button
              key={ns}
              type="button"
              role="option"
              aria-selected={ns === value}
              onClick={() => {
                onChange(ns);
                close();
              }}
              className="flex items-center gap-2 w-full h-7 px-2.5 text-left text-xs font-mono hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] outline-none"
            >
              <span className="truncate flex-1">{ns}</span>
              {ns === value && <Check size="calc(12px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  ) : undefined;

  return (
    <Input
      id={id}
      mono
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      trailing={trailing}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Adaptive repeatable key-value editor used for labels, annotations, selectors, and env vars. */
export function KeyValuePairsEditor({
  entries,
  disabled,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add pair',
  emptyText = 'No entries configured.',
  ariaPrefix = 'Entry',
  onChange,
}: {
  entries: readonly KeyValueEntry[];
  disabled?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  emptyText?: string;
  ariaPrefix?: string;
  onChange: (next: KeyValueEntry[]) => void;
}) {
  const update = (id: number, patch: Partial<KeyValueEntry>) => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };
  const remove = (id: number) => {
    onChange(entries.filter((entry) => entry.id !== id));
  };
  const add = () => {
    onChange([...entries, { id: nextEntryId(entries), key: '', value: '' }]);
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {entries.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
      ) : (
        entries.map((entry, idx) => (
          <div key={entry.id} className="nr-kv-row">
            <Input
              size="sm"
              mono
              disabled={disabled}
              aria-label={`${ariaPrefix} key ${idx + 1}`}
              placeholder={keyPlaceholder}
              value={entry.key}
              onChange={(e) => update(entry.id, { key: e.target.value })}
            />
            <Input
              size="sm"
              mono
              disabled={disabled}
              aria-label={`${ariaPrefix} value ${idx + 1}`}
              placeholder={valuePlaceholder}
              value={entry.value}
              onChange={(e) => update(entry.id, { value: e.target.value })}
            />
            <IconButton
              icon={Trash2}
              size="sm"
              danger
              disabled={disabled}
              aria-label={`Remove ${ariaPrefix.toLowerCase()} ${entry.key || idx + 1}`}
              onClick={() => remove(entry.id)}
            />
          </div>
        ))
      )}
      <div>
        <Button size="xs" variant="secondary" icon={Plus} disabled={disabled} onClick={add}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** Shared collapsible Labels & Annotations card available across every resource form. */
export function MetadataExtrasSection({
  labels,
  annotations,
  defaultOpen = false,
  disabled,
  onChangeLabels,
  onChangeAnnotations,
}: {
  labels: readonly KeyValueEntry[];
  annotations: readonly KeyValueEntry[];
  defaultOpen?: boolean;
  disabled?: boolean;
  onChangeLabels: (next: KeyValueEntry[]) => void;
  onChangeAnnotations: (next: KeyValueEntry[]) => void;
}) {
  const labelCount = labels.filter((l) => l.key.trim()).length;
  const annotationCount = annotations.filter((a) => a.key.trim()).length;
  return (
    <SectionCard
      title="Labels & Annotations"
      subtitle={`${labelCount} labels · ${annotationCount} annotations`}
      icon={Tags}
      collapsible
      defaultOpen={defaultOpen}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-[var(--text-secondary)]">Labels</div>
          <KeyValuePairsEditor
            entries={labels}
            disabled={disabled}
            keyPlaceholder="app.kubernetes.io/part-of"
            valuePlaceholder="payments"
            addLabel="Add label"
            emptyText="No labels set."
            ariaPrefix="Label"
            onChange={onChangeLabels}
          />
        </div>
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
          <div className="text-xs font-medium text-[var(--text-secondary)]">Annotations</div>
          <KeyValuePairsEditor
            entries={annotations}
            disabled={disabled}
            keyPlaceholder="description"
            valuePlaceholder="Managed by platform team"
            addLabel="Add annotation"
            emptyText="No annotations set."
            ariaPrefix="Annotation"
            onChange={onChangeAnnotations}
          />
        </div>
      </div>
    </SectionCard>
  );
}

/** Shared multi-container specification editor reused by Deployment, Pod, Job, and CronJob. */
export function ContainersEditor({
  containers,
  disabled,
  allowPorts = true,
  defaultImage = 'nginx:stable-alpine',
  onChange,
}: {
  containers: readonly ContainerDraft[];
  disabled?: boolean;
  allowPorts?: boolean;
  defaultImage?: string;
  onChange: (next: ContainerDraft[]) => void;
}) {
  const idPrefix = useId();
  const [expandedAdvanced, setExpandedAdvanced] = useState<Record<number, boolean>>({});

  const updateContainer = (id: number, patch: Partial<ContainerDraft>) => {
    onChange(containers.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addContainer = () => {
    const id = nextEntryId(containers);
    onChange([
      ...containers,
      {
        id,
        name: `container-${id}`,
        image: defaultImage,
        imagePullPolicy: '',
        command: '',
        args: '',
        ports: [],
        env: [],
        cpuRequest: '',
        memoryRequest: '',
        cpuLimit: '',
        memoryLimit: '',
      },
    ]);
  };

  const removeContainer = (id: number) => {
    if (containers.length <= 1) return;
    onChange(containers.filter((c) => c.id !== id));
  };

  const updatePort = (container: ContainerDraft, portId: number, patch: Partial<ContainerPortDraft>) => {
    updateContainer(container.id, {
      ports: container.ports.map((p) => (p.id === portId ? { ...p, ...patch } : p)),
    });
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {containers.map((container, idx) => {
        const showAdvanced = Boolean(
          expandedAdvanced[container.id]
          || container.command
          || container.args
          || container.cpuRequest
          || container.memoryRequest
          || container.cpuLimit
          || container.memoryLimit,
        );
        return (
          <SectionCard
            key={container.id}
            title={container.name.trim() ? `Container · ${container.name.trim()}` : `Container #${idx + 1}`}
            subtitle={container.image.trim() || undefined}
            actions={
              containers.length > 1 ? (
                <IconButton
                  icon={Trash2}
                  size="xs"
                  danger
                  disabled={disabled}
                  aria-label={`Remove container ${container.name || idx + 1}`}
                  onClick={() => removeContainer(container.id)}
                />
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3">
              <FieldGroup>
                <Field label="Container Name" htmlFor={`${idPrefix}-${container.id}-name`} required>
                  <Input
                    id={`${idPrefix}-${container.id}-name`}
                    size="sm"
                    mono
                    disabled={disabled}
                    value={container.name}
                    placeholder="app"
                    onChange={(e) => updateContainer(container.id, { name: e.target.value })}
                  />
                </Field>
                <Field label="Image" htmlFor={`${idPrefix}-${container.id}-image`} required>
                  <Input
                    id={`${idPrefix}-${container.id}-image`}
                    size="sm"
                    mono
                    disabled={disabled}
                    value={container.image}
                    placeholder={defaultImage}
                    onChange={(e) => updateContainer(container.id, { image: e.target.value })}
                  />
                </Field>
                <Field label="Image Pull Policy" htmlFor={`${idPrefix}-${container.id}-policy`}>
                  <Select
                    id={`${idPrefix}-${container.id}-policy`}
                    size="sm"
                    disabled={disabled}
                    value={container.imagePullPolicy}
                    onChange={(e) => updateContainer(container.id, { imagePullPolicy: e.target.value as ImagePullPolicy })}
                  >
                    {IMAGE_PULL_POLICIES.map((policy) => (
                      <option key={policy || 'default'} value={policy}>
                        {policy || 'Cluster default'}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FieldGroup>

              {allowPorts && (
                <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Container Ports</span>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={Plus}
                      disabled={disabled}
                      onClick={() =>
                        updateContainer(container.id, {
                          ports: [
                            ...container.ports,
                            { id: nextEntryId(container.ports), name: '', containerPort: '8080', protocol: 'TCP' },
                          ],
                        })
                      }
                    >
                      Add port
                    </Button>
                  </div>
                  {container.ports.map((port, pIdx) => (
                    <div key={port.id} className="nr-port-row">
                      <Input
                        size="sm"
                        mono
                        disabled={disabled}
                        aria-label={`Container ${idx + 1} port name ${pIdx + 1}`}
                        placeholder="name (optional)"
                        value={port.name}
                        onChange={(e) => updatePort(container, port.id, { name: e.target.value })}
                      />
                      <Input
                        size="sm"
                        mono
                        disabled={disabled}
                        aria-label={`Container ${idx + 1} port number ${pIdx + 1}`}
                        placeholder="80"
                        value={port.containerPort}
                        onChange={(e) => updatePort(container, port.id, { containerPort: e.target.value })}
                      />
                      <Select
                        size="sm"
                        disabled={disabled}
                        aria-label={`Container ${idx + 1} port protocol ${pIdx + 1}`}
                        value={port.protocol}
                        onChange={(e) => updatePort(container, port.id, { protocol: e.target.value as PortProtocol })}
                      >
                        {PORT_PROTOCOLS.map((proto) => (
                          <option key={proto} value={proto}>{proto}</option>
                        ))}
                      </Select>
                      <IconButton
                        icon={Trash2}
                        size="sm"
                        danger
                        disabled={disabled}
                        aria-label={`Remove port ${pIdx + 1}`}
                        onClick={() =>
                          updateContainer(container.id, {
                            ports: container.ports.filter((p) => p.id !== port.id),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">Environment Variables</span>
                  {container.preservedEnv && container.preservedEnv.length > 0 && (
                    <Badge size="xs" tone="info">
                      +{container.preservedEnv.length} valueFrom preserved in YAML
                    </Badge>
                  )}
                </div>
                <KeyValuePairsEditor
                  entries={container.env}
                  disabled={disabled}
                  keyPlaceholder="ENV_NAME"
                  valuePlaceholder="value"
                  addLabel="Add env variable"
                  emptyText="No plain environment variables."
                  ariaPrefix={`Container ${idx + 1} env`}
                  onChange={(env) => updateContainer(container.id, { env })}
                />
              </div>

              <div className="pt-2 border-t border-[var(--border-subtle)]">
                {!showAdvanced ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setExpandedAdvanced((prev) => ({ ...prev, [container.id]: true }))}
                  >
                    Configure resources, command & args…
                  </Button>
                ) : (
                  <div className="flex flex-col gap-3">
                    <FieldGroup>
                      <Field label="CPU Request" htmlFor={`${idPrefix}-${container.id}-cpureq`}>
                        <Input
                          id={`${idPrefix}-${container.id}-cpureq`}
                          size="sm"
                          mono
                          disabled={disabled}
                          placeholder="100m"
                          value={container.cpuRequest}
                          onChange={(e) => updateContainer(container.id, { cpuRequest: e.target.value })}
                        />
                      </Field>
                      <Field label="Memory Request" htmlFor={`${idPrefix}-${container.id}-memreq`}>
                        <Input
                          id={`${idPrefix}-${container.id}-memreq`}
                          size="sm"
                          mono
                          disabled={disabled}
                          placeholder="64Mi"
                          value={container.memoryRequest}
                          onChange={(e) => updateContainer(container.id, { memoryRequest: e.target.value })}
                        />
                      </Field>
                      <Field label="CPU Limit" htmlFor={`${idPrefix}-${container.id}-cpulim`}>
                        <Input
                          id={`${idPrefix}-${container.id}-cpulim`}
                          size="sm"
                          mono
                          disabled={disabled}
                          placeholder="500m"
                          value={container.cpuLimit}
                          onChange={(e) => updateContainer(container.id, { cpuLimit: e.target.value })}
                        />
                      </Field>
                      <Field label="Memory Limit" htmlFor={`${idPrefix}-${container.id}-memlim`}>
                        <Input
                          id={`${idPrefix}-${container.id}-memlim`}
                          size="sm"
                          mono
                          disabled={disabled}
                          placeholder="128Mi"
                          value={container.memoryLimit}
                          onChange={(e) => updateContainer(container.id, { memoryLimit: e.target.value })}
                        />
                      </Field>
                    </FieldGroup>
                    <FieldGroup>
                      <Field label="Command (one item per line)" htmlFor={`${idPrefix}-${container.id}-cmd`}>
                        <Textarea
                          id={`${idPrefix}-${container.id}-cmd`}
                          mono
                          rows={2}
                          disabled={disabled}
                          placeholder={'sh\n-c\necho hello'}
                          value={container.command}
                          onChange={(e) => updateContainer(container.id, { command: e.target.value })}
                        />
                      </Field>
                      <Field label="Args (one item per line)" htmlFor={`${idPrefix}-${container.id}-args`}>
                        <Textarea
                          id={`${idPrefix}-${container.id}-args`}
                          mono
                          rows={2}
                          disabled={disabled}
                          placeholder="--port=8080"
                          value={container.args}
                          onChange={(e) => updateContainer(container.id, { args: e.target.value })}
                        />
                      </Field>
                    </FieldGroup>
                  </div>
                )}
              </div>
            </div>
          </SectionCard>
        );
      })}
      <div>
        <Button size="xs" variant="secondary" icon={Plus} disabled={disabled} onClick={addContainer}>
          Add container
        </Button>
      </div>
    </div>
  );
}
