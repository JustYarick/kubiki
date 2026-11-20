import { FileText, Plus, Trash2 } from 'lucide-react';
import {
  nextEntryId,
  type ConfigMapCreatorState,
  type KeyValueEntry,
} from '../../../../core/resources/creators';
import { Button, IconButton } from '../../../ui/Button';
import { CheckboxRow } from '../../../ui/Checkbox';
import { Input, Textarea } from '../../../ui/Input';
import { SectionCard } from '../../../ui/LayoutPrimitives';
import { FileLoadButton } from '../SharedFormParts';
import type { ResourceCreatorFormProps } from '../types';

export function ConfigMapCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<ConfigMapCreatorState>) {
  const updateEntry = (id: number, patch: Partial<KeyValueEntry>) => {
    onChange({
      ...state,
      entries: state.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    });
  };

  const addEntry = () => {
    onChange({
      ...state,
      entries: [...state.entries, { id: nextEntryId(state.entries), key: '', value: '' }],
    });
  };

  const addFromFile = (file: { filename: string; content: string }) => {
    const cleanKey = file.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 253) || 'config.txt';
    const isSingleEmpty = state.entries.length === 1 && !state.entries[0].key.trim() && !state.entries[0].value;
    const entries = isSingleEmpty
      ? [{ id: state.entries[0].id, key: cleanKey, value: file.content }]
      : [...state.entries, { id: nextEntryId(state.entries), key: cleanKey, value: file.content }];
    onChange({ ...state, entries });
  };

  const removeEntry = (id: number) => {
    const remaining = state.entries.filter((entry) => entry.id !== id);
    onChange({
      ...state,
      entries: remaining.length ? remaining : [{ id: 1, key: '', value: '' }],
    });
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <CheckboxRow
        label="Immutable ConfigMap (cannot be updated after creation)"
        checked={state.immutable}
        disabled={disabled}
        onChange={(e) => onChange({ ...state, immutable: e.target.checked })}
      />

      <SectionCard
        title="Data Entries"
        subtitle={`${state.entries.filter((e) => e.key.trim()).length} keys`}
        icon={FileText}
      >
        <div className="flex flex-col gap-2.5 min-w-0">
          {state.entries.map((entry, idx) => (
            <div key={entry.id} className="nr-data-card">
              <div className="nr-data-card-header">
                <Input
                  size="sm"
                  mono
                  className="flex-1 min-w-[160px]"
                  disabled={disabled}
                  aria-label={`ConfigMap key ${idx + 1}`}
                  placeholder="config.yaml or APP_MODE"
                  value={entry.key}
                  onChange={(e) => updateEntry(entry.id, { key: e.target.value })}
                />
                <FileLoadButton
                  label="From file"
                  disabled={disabled}
                  onLoad={(file) =>
                    updateEntry(entry.id, {
                      key: entry.key.trim() ? entry.key : file.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 253),
                      value: file.content,
                    })
                  }
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  danger
                  disabled={disabled}
                  aria-label={`Remove ConfigMap key ${entry.key || idx + 1}`}
                  onClick={() => removeEntry(entry.id)}
                />
              </div>
              <Textarea
                mono
                rows={entry.value.includes('\n') ? 4 : 2}
                disabled={disabled}
                aria-label={`ConfigMap value ${idx + 1}`}
                placeholder="Configuration value or file contents…"
                value={entry.value}
                onChange={(e) => updateEntry(entry.id, { value: e.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" variant="secondary" icon={Plus} disabled={disabled} onClick={addEntry}>
              Add key
            </Button>
            <FileLoadButton
              label="Add from file…"
              disabled={disabled}
              onLoad={addFromFile}
            />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
