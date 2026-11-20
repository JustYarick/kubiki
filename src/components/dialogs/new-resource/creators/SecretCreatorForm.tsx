import { useId, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  convertSecretCreatorRows,
  nextEntryId,
  SECRET_TYPE_PRESETS,
  type SecretCreatorState,
  type SecretTypePreset,
} from '../../../../core/resources/creators';
import type { SecretRow } from '../../../../core/resources/secret_data';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { CheckboxRow } from '../../../ui/Checkbox';
import { Input, Textarea } from '../../../ui/Input';
import { Field, FieldGroup, SectionCard } from '../../../ui/LayoutPrimitives';
import { Select } from '../../../ui/Select';
import { FileLoadButton } from '../SharedFormParts';
import type { ResourceCreatorFormProps } from '../types';

export function SecretCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<SecretCreatorState>) {
  const id = useId();
  const [maskValues, setMaskValues] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [encodingError, setEncodingError] = useState('');

  const patch = (partial: Partial<SecretCreatorState>) => {
    setEncodingError('');
    onChange({ ...state, ...partial });
  };

  const updateRow = (rowId: number, partial: Partial<SecretRow>) => {
    patch({ rows: state.rows.map((row) => (row.id === rowId ? { ...row, ...partial } : row)) });
  };

  const switchEncoding = (mode: SecretRow['mode']) => {
    if (mode === state.encoding) return;
    try {
      const converted = convertSecretCreatorRows(state.rows, mode);
      setEncodingError('');
      onChange({ ...state, encoding: mode, rows: converted });
    } catch {
      setEncodingError('Fix invalid base64 values before switching to Text mode.');
    }
  };

  const addEmptyRow = () => {
    patch({
      rows: [...state.rows, { id: nextEntryId(state.rows), key: '', value: '', mode: state.encoding }],
    });
  };

  const addFileRow = (file: { filename: string; content: string; mode: 'text' | 'base64' }) => {
    const cleanKey = file.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 253) || 'file';
    const nextRows = state.rows.length === 1 && !state.rows[0].key.trim() && !state.rows[0].value
      ? [{ id: state.rows[0].id, key: cleanKey, value: file.content, mode: file.mode }]
      : [...state.rows, { id: nextEntryId(state.rows), key: cleanKey, value: file.content, mode: file.mode }];
    patch({ rows: nextRows });
  };

  const removeRow = (rowId: number) => {
    const remaining = state.rows.filter((row) => row.id !== rowId);
    patch({ rows: remaining.length ? remaining : [{ id: 1, key: '', value: '', mode: state.encoding }] });
  };

  const passwordToggle = (
    <button
      type="button"
      aria-label={showPassword ? 'Hide password' : 'Show password'}
      title={showPassword ? 'Hide password' : 'Show password'}
      onClick={() => setShowPassword((v) => !v)}
      className="flex items-center justify-center h-[var(--control-h-xs)] w-[var(--control-h-xs)] rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
    >
      {showPassword ? <EyeOff size="calc(12px * var(--ui-factor))" /> : <Eye size="calc(12px * var(--ui-factor))" />}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Secret Configuration" icon={Lock}>
        <div className="flex flex-col gap-3">
          <FieldGroup>
            <Field label="Secret Type" htmlFor={`${id}-type`}>
              <Select
                id={`${id}-type`}
                size="sm"
                disabled={disabled}
                value={state.typePreset}
                onChange={(e) => patch({ typePreset: e.target.value as SecretTypePreset })}
              >
                {SECRET_TYPE_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                ))}
              </Select>
            </Field>
            {state.typePreset === 'custom' && (
              <Field label="Custom Type" htmlFor={`${id}-custom-type`} required>
                <Input
                  id={`${id}-custom-type`}
                  size="sm"
                  mono
                  disabled={disabled}
                  placeholder="example.io/custom-token"
                  value={state.customType}
                  onChange={(e) => patch({ customType: e.target.value })}
                />
              </Field>
            )}
          </FieldGroup>

          <CheckboxRow
            label="Immutable Secret (cannot be updated after creation)"
            checked={state.immutable}
            disabled={disabled}
            onChange={(e) => patch({ immutable: e.target.checked })}
          />
        </div>
      </SectionCard>

      {state.typePreset === 'kubernetes.io/tls' && (
        <SectionCard title="TLS Certificate & Key" subtitle="stringData: tls.crt & tls.key" icon={ShieldCheck}>
          <div className="flex flex-col gap-3">
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  <span>Certificate (tls.crt)</span>
                  <FileLoadButton
                    label="Load .crt / .pem"
                    accept=".crt,.cer,.pem,text/plain"
                    disabled={disabled}
                    onLoad={(file) => patch({ tlsCrt: file.content })}
                  />
                </span>
              }
              htmlFor={`${id}-tls-crt`}
              required
            >
              <Textarea
                id={`${id}-tls-crt`}
                mono
                rows={4}
                disabled={disabled}
                placeholder="-----BEGIN CERTIFICATE-----"
                value={state.tlsCrt}
                onChange={(e) => patch({ tlsCrt: e.target.value })}
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  <span>Private Key (tls.key)</span>
                  <FileLoadButton
                    label="Load .key / .pem"
                    accept=".key,.pem,text/plain"
                    disabled={disabled}
                    onLoad={(file) => patch({ tlsKey: file.content })}
                  />
                </span>
              }
              htmlFor={`${id}-tls-key`}
              required
            >
              <Textarea
                id={`${id}-tls-key`}
                mono
                rows={4}
                disabled={disabled}
                placeholder="-----BEGIN PRIVATE KEY-----"
                value={state.tlsKey}
                onChange={(e) => patch({ tlsKey: e.target.value })}
              />
            </Field>
          </div>
        </SectionCard>
      )}

      {state.typePreset === 'kubernetes.io/dockerconfigjson' && (
        <SectionCard title="Container Registry Credentials" subtitle="Generates .dockerconfigjson automatically" icon={KeyRound}>
          <FieldGroup>
            <Field label="Registry Server" htmlFor={`${id}-docker-server`} required>
              <Input
                id={`${id}-docker-server`}
                size="sm"
                mono
                disabled={disabled}
                placeholder="https://index.docker.io/v1/"
                value={state.dockerServer}
                onChange={(e) => patch({ dockerServer: e.target.value })}
              />
            </Field>
            <Field label="Username" htmlFor={`${id}-docker-user`} required>
              <Input
                id={`${id}-docker-user`}
                size="sm"
                mono
                disabled={disabled}
                placeholder="registry-user"
                value={state.dockerUsername}
                onChange={(e) => patch({ dockerUsername: e.target.value })}
              />
            </Field>
            <Field label="Password / Token" htmlFor={`${id}-docker-pass`} required>
              <Input
                id={`${id}-docker-pass`}
                size="sm"
                mono
                type={showPassword ? 'text' : 'password'}
                disabled={disabled}
                placeholder="••••••••"
                trailing={passwordToggle}
                value={state.dockerPassword}
                onChange={(e) => patch({ dockerPassword: e.target.value })}
              />
            </Field>
            <Field label="Email (optional)" htmlFor={`${id}-docker-email`}>
              <Input
                id={`${id}-docker-email`}
                size="sm"
                disabled={disabled}
                placeholder="dev@example.com"
                value={state.dockerEmail}
                onChange={(e) => patch({ dockerEmail: e.target.value })}
              />
            </Field>
          </FieldGroup>
        </SectionCard>
      )}

      {state.typePreset === 'kubernetes.io/basic-auth' && (
        <SectionCard title="Basic Authentication" subtitle="stringData: username & password" icon={KeyRound}>
          <FieldGroup>
            <Field label="Username" htmlFor={`${id}-basic-user`}>
              <Input
                id={`${id}-basic-user`}
                size="sm"
                mono
                disabled={disabled}
                placeholder="admin"
                value={state.basicUsername}
                onChange={(e) => patch({ basicUsername: e.target.value })}
              />
            </Field>
            <Field label="Password" htmlFor={`${id}-basic-pass`}>
              <Input
                id={`${id}-basic-pass`}
                size="sm"
                mono
                type={showPassword ? 'text' : 'password'}
                disabled={disabled}
                placeholder="••••••••"
                trailing={passwordToggle}
                value={state.basicPassword}
                onChange={(e) => patch({ basicPassword: e.target.value })}
              />
            </Field>
          </FieldGroup>
        </SectionCard>
      )}

      {state.typePreset === 'kubernetes.io/ssh-auth' && (
        <SectionCard title="SSH Authentication" subtitle="stringData: ssh-privatekey" icon={KeyRound}>
          <Field
            label={
              <span className="inline-flex items-center gap-2">
                <span>SSH Private Key (ssh-privatekey)</span>
                <FileLoadButton
                  label="Load key file"
                  disabled={disabled}
                  onLoad={(file) => patch({ sshPrivateKey: file.content })}
                />
              </span>
            }
            htmlFor={`${id}-ssh-key`}
            required
          >
            <Textarea
              id={`${id}-ssh-key`}
              mono
              rows={5}
              disabled={disabled}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={state.sshPrivateKey}
              onChange={(e) => patch({ sshPrivateKey: e.target.value })}
            />
          </Field>
        </SectionCard>
      )}

      {(state.typePreset === 'Opaque' || state.typePreset === 'custom') && (
        <SectionCard
          title="Secret Data"
          subtitle={`${state.rows.filter((r) => r.key.trim()).length} keys`}
          icon={KeyRound}
          actions={
            <div className="flex items-center gap-1.5 flex-wrap">
              <div role="group" aria-label="Secret value encoding" className="nr-mode-switch">
                {(['text', 'base64'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={state.encoding === mode}
                    disabled={disabled}
                    className="nr-mode-btn"
                    onClick={() => switchEncoding(mode)}
                  >
                    {mode === 'text' ? 'Text' : 'Base64'}
                  </button>
                ))}
              </div>
              <Button
                size="xs"
                variant="secondary"
                icon={maskValues ? Eye : EyeOff}
                disabled={disabled}
                onClick={() => setMaskValues((v) => !v)}
              >
                {maskValues ? 'Show' : 'Mask'}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-2.5 min-w-0">
            <p className="text-xs text-[var(--text-muted)]">
              Text entries are written to <code className="font-mono">stringData</code> (Kubernetes encodes them on create); Base64 or binary files are written to <code className="font-mono">data</code>.
            </p>
            {encodingError && (
              <p role="alert" className="text-xs text-[var(--status-danger)]">{encodingError}</p>
            )}
            {state.rows.map((row, idx) => {
              const isMultiline = row.value.includes('\n');
              return (
                <div key={row.id} className="nr-data-card">
                  <div className="nr-data-card-header">
                    <Input
                      size="sm"
                      mono
                      className="flex-1 min-w-[160px]"
                      disabled={disabled}
                      aria-label={`Secret key ${idx + 1}`}
                      placeholder="KEY_NAME (e.g. DATABASE_URL)"
                      value={row.key}
                      onChange={(e) => updateRow(row.id, { key: e.target.value })}
                    />
                    {row.mode === 'base64' && state.encoding === 'text' && (
                      <Badge size="xs" tone="info">Binary · base64</Badge>
                    )}
                    <FileLoadButton
                      label="From file"
                      allowBinary
                      disabled={disabled}
                      onLoad={(file) =>
                        updateRow(row.id, {
                          key: row.key.trim() ? row.key : file.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 253),
                          value: file.content,
                          mode: file.mode,
                        })
                      }
                    />
                    <IconButton
                      icon={Trash2}
                      size="sm"
                      danger
                      disabled={disabled}
                      aria-label={`Remove secret key ${row.key || idx + 1}`}
                      onClick={() => removeRow(row.id)}
                    />
                  </div>
                  {maskValues && !isMultiline ? (
                    <Input
                      size="sm"
                      mono
                      type="password"
                      disabled={disabled}
                      aria-label={`Secret value ${idx + 1}`}
                      placeholder={row.mode === 'base64' ? 'Base64-encoded value' : 'Secret value'}
                      value={row.value}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    />
                  ) : (
                    <Textarea
                      mono
                      rows={isMultiline ? 3 : 2}
                      disabled={disabled}
                      aria-label={`Secret value ${idx + 1}`}
                      placeholder={row.mode === 'base64' ? 'Base64-encoded value (e.g. c2VjcmV0)' : 'Secret value'}
                      value={row.value}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="xs" variant="secondary" icon={Plus} disabled={disabled} onClick={addEmptyRow}>
                Add key
              </Button>
              <FileLoadButton
                label="Add from file…"
                allowBinary
                disabled={disabled}
                onLoad={addFileRow}
              />
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
