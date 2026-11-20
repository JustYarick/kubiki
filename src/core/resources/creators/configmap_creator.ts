import { deletePath, entriesToRecord, K8S_DATA_KEY_PATTERN, patchManifest, readStringEntries, setPath, validateKeyValueEntries } from './manifest_helpers';
import type { KeyValueEntry, ResourceCreatorModel } from './types';

export interface ConfigMapCreatorState {
  immutable: boolean;
  entries: KeyValueEntry[];
}

export const configMapCreatorModel: ResourceCreatorModel<ConfigMapCreatorState> = {
  group: '',
  kind: 'ConfigMap',
  description: 'Store non-sensitive configuration files and key-value settings.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const entries = readStringEntries(object.data);
    return {
      immutable: object.immutable === true,
      entries: entries.length ? entries : [{ id: 1, key: '', value: '' }],
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      if (state.immutable) setPath(doc, ['immutable'], true);
      else deletePath(doc, ['immutable']);

      const record = entriesToRecord(state.entries);
      if (Object.keys(record).length > 0) {
        setPath(doc, ['data'], record);
      } else {
        deletePath(doc, ['data']);
      }
    });
  },

  validate(state) {
    const err = validateKeyValueEntries(state.entries, 'ConfigMap data', K8S_DATA_KEY_PATTERN);
    if (err) return err;
    let totalBytes = 0;
    const encoder = new TextEncoder();
    for (const entry of state.entries) {
      if (!entry.key.trim()) continue;
      if (entry.key.trim().length > 253) {
        return `ConfigMap key "${entry.key.trim()}" exceeds 253 characters.`;
      }
      totalBytes += encoder.encode(entry.value).length;
      if (totalBytes > 1024 * 1024) {
        return 'ConfigMap data exceeds the 1 MiB Kubernetes limit.';
      }
    }
    return '';
  },
};
