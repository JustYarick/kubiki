import { useId } from 'react';
import { Globe, HardDrive, Lock, Network, Plus, Trash2 } from 'lucide-react';
import {
  INGRESS_PATH_TYPES,
  nextEntryId,
  PORT_PROTOCOLS,
  PVC_ACCESS_MODES,
  PVC_VOLUME_MODES,
  SERVICE_TYPES,
  type IngressCreatorState,
  type IngressPathDraft,
  type IngressPathType,
  type IngressRuleDraft,
  type IngressTlsDraft,
  type PortProtocol,
  type PvcAccessMode,
  type PvcCreatorState,
  type PvcVolumeMode,
  type ServiceCreatorState,
  type ServicePortDraft,
  type ServiceTypeOption,
} from '../../../../core/resources/creators';
import { Button, IconButton } from '../../../ui/Button';
import { CheckboxRow } from '../../../ui/Checkbox';
import { Input } from '../../../ui/Input';
import { Field, FieldGroup, SectionCard } from '../../../ui/LayoutPrimitives';
import { Select } from '../../../ui/Select';
import { KeyValuePairsEditor } from '../SharedFormParts';
import type { ResourceCreatorFormProps } from '../types';

export function ServiceCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<ServiceCreatorState>) {
  const id = useId();
  const showNodePort = state.serviceType === 'NodePort' || state.serviceType === 'LoadBalancer';

  const updatePort = (portId: number, patch: Partial<ServicePortDraft>) => {
    onChange({
      ...state,
      ports: state.ports.map((p) => (p.id === portId ? { ...p, ...patch } : p)),
    });
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Service Configuration" icon={Network}>
        <div className="flex flex-col gap-3">
          <FieldGroup>
            <Field label="Service Type" htmlFor={`${id}-type`}>
              <Select
                id={`${id}-type`}
                size="sm"
                disabled={disabled}
                value={state.serviceType}
                onChange={(e) => {
                  const nextType = e.target.value as ServiceTypeOption;
                  onChange({ ...state, serviceType: nextType, headless: nextType === 'ClusterIP' ? state.headless : false });
                }}
              >
                {SERVICE_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </Field>
            {state.serviceType === 'ExternalName' ? (
              <Field label="External DNS Name" htmlFor={`${id}-ext`} required>
                <Input
                  id={`${id}-ext`}
                  size="sm"
                  mono
                  disabled={disabled}
                  placeholder="my.database.example.com"
                  value={state.externalName}
                  onChange={(e) => onChange({ ...state, externalName: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Session Affinity" htmlFor={`${id}-affinity`}>
                <Select
                  id={`${id}-affinity`}
                  size="sm"
                  disabled={disabled}
                  value={state.sessionAffinity}
                  onChange={(e) => onChange({ ...state, sessionAffinity: e.target.value as 'None' | 'ClientIP' })}
                >
                  <option value="None">None</option>
                  <option value="ClientIP">ClientIP</option>
                </Select>
              </Field>
            )}
          </FieldGroup>

          {state.serviceType === 'ClusterIP' && (
            <CheckboxRow
              label="Headless Service (clusterIP: None)"
              checked={state.headless}
              disabled={disabled}
              onChange={(e) => onChange({ ...state, headless: e.target.checked })}
            />
          )}
        </div>
      </SectionCard>

      {state.serviceType !== 'ExternalName' && (
        <>
          <SectionCard title="Ports" subtitle={`${state.ports.length} configured`}>
            <div className="flex flex-col gap-2 min-w-0">
              {state.ports.map((port, idx) => (
                <div key={port.id} className="nr-service-port-row" data-nodeport={showNodePort ? 'true' : undefined}>
                  <Input
                    size="sm"
                    mono
                    disabled={disabled}
                    aria-label={`Service port name ${idx + 1}`}
                    placeholder="name (http)"
                    value={port.name}
                    onChange={(e) => updatePort(port.id, { name: e.target.value })}
                  />
                  <Input
                    size="sm"
                    mono
                    disabled={disabled}
                    aria-label={`Service port ${idx + 1}`}
                    placeholder="port (80)"
                    value={port.port}
                    onChange={(e) => updatePort(port.id, { port: e.target.value })}
                  />
                  <Input
                    size="sm"
                    mono
                    disabled={disabled}
                    aria-label={`Target port ${idx + 1}`}
                    placeholder="targetPort"
                    value={port.targetPort}
                    onChange={(e) => updatePort(port.id, { targetPort: e.target.value })}
                  />
                  {showNodePort && (
                    <Input
                      size="sm"
                      mono
                      disabled={disabled}
                      aria-label={`Node port ${idx + 1}`}
                      placeholder="nodePort"
                      value={port.nodePort}
                      onChange={(e) => updatePort(port.id, { nodePort: e.target.value })}
                    />
                  )}
                  <Select
                    size="sm"
                    disabled={disabled}
                    aria-label={`Protocol ${idx + 1}`}
                    value={port.protocol}
                    onChange={(e) => updatePort(port.id, { protocol: e.target.value as PortProtocol })}
                  >
                    {PORT_PROTOCOLS.map((proto) => (
                      <option key={proto} value={proto}>{proto}</option>
                    ))}
                  </Select>
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    danger
                    disabled={disabled || state.ports.length <= 1}
                    aria-label={`Remove service port ${idx + 1}`}
                    onClick={() => onChange({ ...state, ports: state.ports.filter((p) => p.id !== port.id) })}
                  />
                </div>
              ))}
              <div>
                <Button
                  size="xs"
                  variant="secondary"
                  icon={Plus}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...state,
                      ports: [
                        ...state.ports,
                        { id: nextEntryId(state.ports), name: `port-${state.ports.length + 1}`, protocol: 'TCP', port: '8080', targetPort: '8080', nodePort: '' },
                      ],
                    })
                  }
                >
                  Add port
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Pod Selector" subtitle="Target Pods matching these labels">
            <KeyValuePairsEditor
              entries={state.selector}
              disabled={disabled}
              keyPlaceholder="app"
              valuePlaceholder="web"
              addLabel="Add selector"
              emptyText="No selector (manage Endpoints manually)."
              ariaPrefix="Selector"
              onChange={(selector) => onChange({ ...state, selector })}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}

export function IngressCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<IngressCreatorState>) {
  const id = useId();

  const updateRule = (ruleId: number, patch: Partial<IngressRuleDraft>) => {
    onChange({
      ...state,
      rules: state.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)),
    });
  };

  const updatePath = (rule: IngressRuleDraft, pathId: number, patch: Partial<IngressPathDraft>) => {
    updateRule(rule.id, {
      paths: rule.paths.map((p) => (p.id === pathId ? { ...p, ...patch } : p)),
    });
  };

  const updateTls = (tlsId: number, patch: Partial<IngressTlsDraft>) => {
    onChange({
      ...state,
      tls: state.tls.map((t) => (t.id === tlsId ? { ...t, ...patch } : t)),
    });
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Ingress Controller" icon={Globe}>
        <Field label="Ingress Class Name (optional)" htmlFor={`${id}-class`} hint="Leave blank to use the cluster default IngressClass.">
          <Input
            id={`${id}-class`}
            size="sm"
            mono
            disabled={disabled}
            placeholder="nginx"
            value={state.ingressClassName}
            onChange={(e) => onChange({ ...state, ingressClassName: e.target.value })}
          />
        </Field>
      </SectionCard>

      <SectionCard title="Routing Rules" subtitle={`${state.rules.length} host rules`} icon={Globe}>
        <div className="flex flex-col gap-3 min-w-0">
          {state.rules.map((rule, rIdx) => (
            <div key={rule.id} className="nr-data-card">
              <div className="nr-data-card-header">
                <Input
                  size="sm"
                  mono
                  className="flex-1 min-w-[180px]"
                  disabled={disabled}
                  aria-label={`Ingress host ${rIdx + 1}`}
                  placeholder="app.example.com (leave empty for any host)"
                  value={rule.host}
                  onChange={(e) => updateRule(rule.id, { host: e.target.value })}
                />
                {state.rules.length > 1 && (
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    danger
                    disabled={disabled}
                    aria-label={`Remove rule ${rIdx + 1}`}
                    onClick={() => onChange({ ...state, rules: state.rules.filter((r) => r.id !== rule.id) })}
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                {rule.paths.map((p, pIdx) => (
                  <div key={p.id} className="nr-ingress-path-row">
                    <Input
                      size="sm"
                      mono
                      disabled={disabled}
                      aria-label={`Rule ${rIdx + 1} path ${pIdx + 1}`}
                      placeholder="/"
                      value={p.path}
                      onChange={(e) => updatePath(rule, p.id, { path: e.target.value })}
                    />
                    <Select
                      size="sm"
                      disabled={disabled}
                      aria-label={`Rule ${rIdx + 1} path type ${pIdx + 1}`}
                      value={p.pathType}
                      onChange={(e) => updatePath(rule, p.id, { pathType: e.target.value as IngressPathType })}
                    >
                      {INGRESS_PATH_TYPES.map((pt) => (
                        <option key={pt} value={pt}>{pt}</option>
                      ))}
                    </Select>
                    <Input
                      size="sm"
                      mono
                      disabled={disabled}
                      aria-label={`Rule ${rIdx + 1} service ${pIdx + 1}`}
                      placeholder="service-name"
                      value={p.serviceName}
                      onChange={(e) => updatePath(rule, p.id, { serviceName: e.target.value })}
                    />
                    <Input
                      size="sm"
                      mono
                      disabled={disabled}
                      aria-label={`Rule ${rIdx + 1} port ${pIdx + 1}`}
                      placeholder="80"
                      value={p.servicePort}
                      onChange={(e) => updatePath(rule, p.id, { servicePort: e.target.value })}
                    />
                    <IconButton
                      icon={Trash2}
                      size="sm"
                      danger
                      disabled={disabled || rule.paths.length <= 1}
                      aria-label={`Remove path ${pIdx + 1}`}
                      onClick={() => updateRule(rule.id, { paths: rule.paths.filter((item) => item.id !== p.id) })}
                    />
                  </div>
                ))}
                <div>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={Plus}
                    disabled={disabled}
                    onClick={() =>
                      updateRule(rule.id, {
                        paths: [...rule.paths, { id: nextEntryId(rule.paths), path: '/api', pathType: 'Prefix', serviceName: '', servicePort: '80' }],
                      })
                    }
                  >
                    Add path
                  </Button>
                </div>
              </div>
            </div>
          ))}
          <div>
            <Button
              size="xs"
              variant="secondary"
              icon={Plus}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...state,
                  rules: [
                    ...state.rules,
                    { id: nextEntryId(state.rules), host: '', paths: [{ id: 1, path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] },
                  ],
                })
              }
            >
              Add host rule
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="TLS Certificates"
        subtitle={`${state.tls.length} configured`}
        icon={Lock}
        collapsible
        defaultOpen={state.tls.length > 0}
      >
        <div className="flex flex-col gap-2 min-w-0">
          {state.tls.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No TLS certificates attached (HTTP only).</p>
          ) : (
            state.tls.map((entry, idx) => (
              <div key={entry.id} className="nr-kv-row">
                <Input
                  size="sm"
                  mono
                  disabled={disabled}
                  aria-label={`TLS secret name ${idx + 1}`}
                  placeholder="tls-secret-name"
                  value={entry.secretName}
                  onChange={(e) => updateTls(entry.id, { secretName: e.target.value })}
                />
                <Input
                  size="sm"
                  mono
                  disabled={disabled}
                  aria-label={`TLS hosts ${idx + 1}`}
                  placeholder="app.example.com, www.example.com"
                  value={entry.hosts}
                  onChange={(e) => updateTls(entry.id, { hosts: e.target.value })}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  danger
                  disabled={disabled}
                  aria-label={`Remove TLS entry ${idx + 1}`}
                  onClick={() => onChange({ ...state, tls: state.tls.filter((t) => t.id !== entry.id) })}
                />
              </div>
            ))
          )}
          <div>
            <Button
              size="xs"
              variant="secondary"
              icon={Plus}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...state,
                  tls: [...state.tls, { id: nextEntryId(state.tls), secretName: '', hosts: state.rules[0]?.host ?? '' }],
                })
              }
            >
              Add TLS entry
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

const STORAGE_PRESETS = ['1Gi', '5Gi', '10Gi', '50Gi', '100Gi'] as const;

export function PvcCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<PvcCreatorState>) {
  const id = useId();
  const toggleMode = (mode: PvcAccessMode, checked: boolean) => {
    const next = checked
      ? [...state.accessModes, mode]
      : state.accessModes.filter((m) => m !== mode);
    onChange({ ...state, accessModes: next });
  };

  return (
    <SectionCard title="Storage Claim" icon={HardDrive}>
      <div className="flex flex-col gap-3">
        <FieldGroup>
          <Field label="Requested Storage" htmlFor={`${id}-storage`} required>
            <Input
              id={`${id}-storage`}
              size="sm"
              mono
              disabled={disabled}
              placeholder="10Gi"
              value={state.storage}
              onChange={(e) => onChange({ ...state, storage: e.target.value })}
            />
            <div className="nr-preset-row">
              {STORAGE_PRESETS.map((size) => (
                <button
                  key={size}
                  type="button"
                  disabled={disabled}
                  data-active={state.storage.trim() === size ? 'true' : undefined}
                  className="nr-preset-chip"
                  onClick={() => onChange({ ...state, storage: size })}
                >
                  {size}
                </button>
              ))}
            </div>
          </Field>

          <Field label="StorageClass Name (optional)" htmlFor={`${id}-sc`} hint="Leave empty for the default StorageClass.">
            <Input
              id={`${id}-sc`}
              size="sm"
              mono
              disabled={disabled}
              placeholder="Cluster default"
              value={state.storageClassName}
              onChange={(e) => onChange({ ...state, storageClassName: e.target.value })}
            />
          </Field>

          <Field label="Volume Mode" htmlFor={`${id}-volmode`}>
            <Select
              id={`${id}-volmode`}
              size="sm"
              disabled={disabled}
              value={state.volumeMode}
              onChange={(e) => onChange({ ...state, volumeMode: e.target.value as PvcVolumeMode })}
            >
              {PVC_VOLUME_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </Select>
          </Field>
        </FieldGroup>

        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Access Modes</span>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {PVC_ACCESS_MODES.map((mode) => (
              <CheckboxRow
                key={mode}
                label={mode}
                checked={state.accessModes.includes(mode)}
                disabled={disabled}
                onChange={(e) => toggleMode(mode, e.target.checked)}
              />
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
