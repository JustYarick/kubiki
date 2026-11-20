import { useId } from 'react';
import { Plus, Shield, Trash2, UserCheck } from 'lucide-react';
import {
  nextEntryId,
  POD_SECURITY_LEVELS,
  type AutomountOption,
  type NamespaceCreatorState,
  type PodSecurityLevel,
  type ServiceAccountCreatorState,
} from '../../../../core/resources/creators';
import { Button, IconButton } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Field, SectionCard } from '../../../ui/LayoutPrimitives';
import { Select } from '../../../ui/Select';
import type { ResourceCreatorFormProps } from '../types';

export function NamespaceCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<NamespaceCreatorState>) {
  const id = useId();
  return (
    <SectionCard title="Pod Security Admission" icon={Shield}>
      <Field
        label="Enforce Level (pod-security.kubernetes.io/enforce)"
        htmlFor={`${id}-pss`}
        hint="Optional built-in Pod Security Standard label enforced on Pods in this namespace."
      >
        <Select
          id={`${id}-pss`}
          size="sm"
          disabled={disabled}
          value={state.podSecurityEnforce}
          onChange={(e) => onChange({ ...state, podSecurityEnforce: e.target.value as PodSecurityLevel })}
        >
          {POD_SECURITY_LEVELS.map((level) => (
            <option key={level || 'none'} value={level}>
              {level ? level : 'Not set (cluster default)'}
            </option>
          ))}
        </Select>
      </Field>
    </SectionCard>
  );
}

export function ServiceAccountCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<ServiceAccountCreatorState>) {
  const id = useId();
  const addSecret = () => {
    onChange({
      ...state,
      imagePullSecrets: [...state.imagePullSecrets, { id: nextEntryId(state.imagePullSecrets), name: '' }],
    });
  };
  const updateSecret = (entryId: number, name: string) => {
    onChange({
      ...state,
      imagePullSecrets: state.imagePullSecrets.map((s) => (s.id === entryId ? { ...s, name } : s)),
    });
  };
  const removeSecret = (entryId: number) => {
    onChange({
      ...state,
      imagePullSecrets: state.imagePullSecrets.filter((s) => s.id !== entryId),
    });
  };

  return (
    <SectionCard title="ServiceAccount Options" icon={UserCheck}>
      <div className="flex flex-col gap-3">
        <Field
          label="Automount API Credentials Token"
          htmlFor={`${id}-automount`}
          hint="Controls whether Pods using this ServiceAccount automatically receive an API token."
        >
          <Select
            id={`${id}-automount`}
            size="sm"
            disabled={disabled}
            value={state.automountToken}
            onChange={(e) => onChange({ ...state, automountToken: e.target.value as AutomountOption })}
          >
            <option value="default">Cluster default</option>
            <option value="true">Enabled (true)</option>
            <option value="false">Disabled (false)</option>
          </Select>
        </Field>

        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Image Pull Secrets</span>
          {state.imagePullSecrets.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No image pull secrets attached.</p>
          ) : (
            state.imagePullSecrets.map((secret, idx) => (
              <div key={secret.id} className="flex items-center gap-2 min-w-0">
                <Input
                  size="sm"
                  mono
                  className="flex-1"
                  disabled={disabled}
                  aria-label={`Image pull secret ${idx + 1}`}
                  placeholder="regcred"
                  value={secret.name}
                  onChange={(e) => updateSecret(secret.id, e.target.value)}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  danger
                  disabled={disabled}
                  aria-label={`Remove image pull secret ${secret.name || idx + 1}`}
                  onClick={() => removeSecret(secret.id)}
                />
              </div>
            ))
          )}
          <div>
            <Button size="xs" variant="secondary" icon={Plus} disabled={disabled} onClick={addSecret}>
              Add image pull secret
            </Button>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
