import { decodeBase64, encodeText, secretRows, type SecretRow } from '../secret_data';
import { deletePath, K8S_DATA_KEY_PATTERN, patchManifest, setPath } from './manifest_helpers';
import type { ResourceCreatorModel } from './types';

export const SECRET_TYPE_PRESETS = [
  { value: 'Opaque', label: 'Opaque (Key / Value)' },
  { value: 'kubernetes.io/tls', label: 'TLS Certificate (kubernetes.io/tls)' },
  { value: 'kubernetes.io/dockerconfigjson', label: 'Container Registry (dockerconfigjson)' },
  { value: 'kubernetes.io/basic-auth', label: 'Basic Auth (username / password)' },
  { value: 'kubernetes.io/ssh-auth', label: 'SSH Private Key (ssh-auth)' },
  { value: 'custom', label: 'Custom type…' },
] as const;

export type SecretTypePreset = (typeof SECRET_TYPE_PRESETS)[number]['value'];

export interface SecretCreatorState {
  typePreset: SecretTypePreset;
  customType: string;
  immutable: boolean;
  /** Encoding toggle for Opaque / custom key-value entries. */
  encoding: SecretRow['mode'];
  rows: SecretRow[];
  /** Specialized fields for `kubernetes.io/tls`. */
  tlsCrt: string;
  tlsKey: string;
  /** Specialized fields for `kubernetes.io/dockerconfigjson`. */
  dockerServer: string;
  dockerUsername: string;
  dockerPassword: string;
  dockerEmail: string;
  /** Specialized fields for `kubernetes.io/basic-auth`. */
  basicUsername: string;
  basicPassword: string;
  /** Specialized field for `kubernetes.io/ssh-auth`. */
  sshPrivateKey: string;
}

const KNOWN_PRESETS = new Set<string>(SECRET_TYPE_PRESETS.map((p) => p.value).filter((v) => v !== 'custom'));

function decodeUtf8SecretValue(rawData: Record<string, unknown> | undefined, rawStringData: Record<string, unknown> | undefined, key: string): string {
  if (rawStringData && typeof rawStringData[key] === 'string') {
    return rawStringData[key] as string;
  }
  const encoded = rawData?.[key];
  if (typeof encoded !== 'string') return '';
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodeBase64(encoded));
  } catch {
    return '';
  }
}

function parseDockerConfigJson(raw: string): Pick<SecretCreatorState, 'dockerServer' | 'dockerUsername' | 'dockerPassword' | 'dockerEmail'> {
  const empty = { dockerServer: 'https://index.docker.io/v1/', dockerUsername: '', dockerPassword: '', dockerEmail: '' };
  if (!raw.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as { auths?: Record<string, Record<string, unknown>> };
    const entries = parsed?.auths && typeof parsed.auths === 'object' ? Object.entries(parsed.auths) : [];
    if (!entries.length) return empty;
    const [server, creds] = entries[0];
    let username = typeof creds?.username === 'string' ? creds.username : '';
    let password = typeof creds?.password === 'string' ? creds.password : '';
    const email = typeof creds?.email === 'string' ? creds.email : '';
    if ((!username || !password) && typeof creds?.auth === 'string') {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(creds.auth));
        const sep = decoded.indexOf(':');
        if (sep >= 0) {
          username ||= decoded.slice(0, sep);
          password ||= decoded.slice(sep + 1);
        }
      } catch { /* ignore malformed auth */ }
    }
    return { dockerServer: server, dockerUsername: username, dockerPassword: password, dockerEmail: email };
  } catch {
    return empty;
  }
}

export function buildDockerConfigJson(state: Pick<SecretCreatorState, 'dockerServer' | 'dockerUsername' | 'dockerPassword' | 'dockerEmail'>): string {
  const server = state.dockerServer.trim();
  const entry: Record<string, string> = {
    username: state.dockerUsername,
    password: state.dockerPassword,
  };
  if (state.dockerEmail.trim()) {
    entry.email = state.dockerEmail.trim();
  }
  entry.auth = encodeText(`${state.dockerUsername}:${state.dockerPassword}`);
  return JSON.stringify({ auths: { [server || 'https://index.docker.io/v1/']: entry } });
}

/** Convert Opaque Secret rows between Text and Base64 modes without losing binary entries. */
export function convertSecretCreatorRows(rows: readonly SecretRow[], targetMode: SecretRow['mode']): SecretRow[] {
  return rows.map((row) => {
    if (row.mode === targetMode) return row;
    if (targetMode === 'base64') {
      return { ...row, mode: 'base64', value: encodeText(row.value) };
    }
    const bytes = decodeBase64(row.value);
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { ...row, mode: 'text', value: text };
    } catch {
      // Binary payload cannot be represented as UTF-8 text; retain base64 mode for this row.
      return row;
    }
  });
}

function readCombinedRows(rawData: Record<string, unknown> | undefined, rawStringData: Record<string, unknown> | undefined): SecretRow[] {
  const dataStrings: Record<string, string> = {};
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    for (const [k, v] of Object.entries(rawData)) {
      if (typeof v === 'string') dataStrings[k] = v;
    }
  }
  const fromData = secretRows(dataStrings);
  const byKey = new Map<string, SecretRow>();
  let nextId = 1;
  for (const row of fromData) {
    byKey.set(row.key, { ...row, id: nextId++ });
  }
  if (rawStringData && typeof rawStringData === 'object' && !Array.isArray(rawStringData)) {
    for (const [k, v] of Object.entries(rawStringData)) {
      const text = v === null || v === undefined ? '' : String(v);
      const existing = byKey.get(k);
      byKey.set(k, { id: existing ? existing.id : nextId++, key: k, value: text, mode: 'text' });
    }
  }
  const list = [...byKey.values()];
  return list.length ? list : [{ id: 1, key: '', value: '', mode: 'text' }];
}

export function effectiveSecretType(state: SecretCreatorState): string {
  return state.typePreset === 'custom' ? state.customType.trim() : state.typePreset;
}

export const secretCreatorModel: ResourceCreatorModel<SecretCreatorState> = {
  group: '',
  kind: 'Secret',
  description: 'Store sensitive credentials, TLS certificates, or registry tokens.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const rawType = typeof object.type === 'string' && object.type.trim() ? object.type.trim() : 'Opaque';
    const typePreset: SecretTypePreset = KNOWN_PRESETS.has(rawType) ? (rawType as SecretTypePreset) : 'custom';
    const rawData = object.data && typeof object.data === 'object' && !Array.isArray(object.data) ? object.data : undefined;
    const rawStringData = object.stringData && typeof object.stringData === 'object' && !Array.isArray(object.stringData) ? object.stringData : undefined;
    const rows = readCombinedRows(rawData, rawStringData);
    const hasOnlyBase64 = Boolean(rawData && Object.keys(rawData).length && (!rawStringData || !Object.keys(rawStringData).length)) && rows.every((r) => r.mode === 'base64');
    const dockerRaw = decodeUtf8SecretValue(rawData, rawStringData, '.dockerconfigjson');
    const docker = parseDockerConfigJson(dockerRaw);

    return {
      typePreset,
      customType: typePreset === 'custom' ? rawType : '',
      immutable: object.immutable === true,
      encoding: hasOnlyBase64 ? 'base64' : 'text',
      rows,
      tlsCrt: decodeUtf8SecretValue(rawData, rawStringData, 'tls.crt'),
      tlsKey: decodeUtf8SecretValue(rawData, rawStringData, 'tls.key'),
      ...docker,
      basicUsername: decodeUtf8SecretValue(rawData, rawStringData, 'username'),
      basicPassword: decodeUtf8SecretValue(rawData, rawStringData, 'password'),
      sshPrivateKey: decodeUtf8SecretValue(rawData, rawStringData, 'ssh-privatekey'),
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      const secretType = effectiveSecretType(state) || 'Opaque';
      setPath(doc, ['type'], secretType);

      if (state.immutable) setPath(doc, ['immutable'], true);
      else deletePath(doc, ['immutable']);

      if (state.typePreset === 'kubernetes.io/tls') {
        deletePath(doc, ['data']);
        setPath(doc, ['stringData'], { 'tls.crt': state.tlsCrt, 'tls.key': state.tlsKey });
        return;
      }

      if (state.typePreset === 'kubernetes.io/dockerconfigjson') {
        deletePath(doc, ['stringData']);
        setPath(doc, ['data'], { '.dockerconfigjson': encodeText(buildDockerConfigJson(state)) });
        return;
      }

      if (state.typePreset === 'kubernetes.io/basic-auth') {
        deletePath(doc, ['data']);
        setPath(doc, ['stringData'], { username: state.basicUsername, password: state.basicPassword });
        return;
      }

      if (state.typePreset === 'kubernetes.io/ssh-auth') {
        deletePath(doc, ['data']);
        setPath(doc, ['stringData'], { 'ssh-privatekey': state.sshPrivateKey });
        return;
      }

      // Opaque / custom key-value rows: text rows go to stringData, base64/binary rows go to data.
      const stringData: Record<string, string> = {};
      const data: Record<string, string> = {};
      for (const row of state.rows) {
        const key = row.key.trim();
        if (!key) continue;
        if (row.mode === 'base64') data[key] = row.value;
        else stringData[key] = row.value;
      }
      const hasData = Object.keys(data).length > 0;
      const hasStringData = Object.keys(stringData).length > 0;
      if (hasData) setPath(doc, ['data'], data);
      else deletePath(doc, ['data']);

      if (hasStringData || !hasData) setPath(doc, ['stringData'], stringData);
      else deletePath(doc, ['stringData']);
    });
  },

  validate(state) {
    if (state.typePreset === 'custom' && !state.customType.trim()) {
      return 'Enter a custom Secret type (for example, Opaque or example.io/token).';
    }
    if (state.typePreset === 'kubernetes.io/tls') {
      if (!state.tlsCrt.trim()) return 'TLS Secret requires a certificate (tls.crt).';
      if (!state.tlsKey.trim()) return 'TLS Secret requires a private key (tls.key).';
      return '';
    }
    if (state.typePreset === 'kubernetes.io/dockerconfigjson') {
      if (!state.dockerServer.trim()) return 'Container registry Secret requires a registry server address.';
      if (!state.dockerUsername.trim()) return 'Container registry Secret requires a username.';
      if (!state.dockerPassword) return 'Container registry Secret requires a password or token.';
      return '';
    }
    if (state.typePreset === 'kubernetes.io/basic-auth') {
      if (!state.basicUsername.trim() && !state.basicPassword) {
        return 'Basic Auth Secret requires a username or password.';
      }
      return '';
    }
    if (state.typePreset === 'kubernetes.io/ssh-auth') {
      if (!state.sshPrivateKey.trim()) return 'SSH Auth Secret requires a private key (ssh-privatekey).';
      return '';
    }

    const seen = new Set<string>();
    let totalBytes = 0;
    const encoder = new TextEncoder();
    for (const row of state.rows) {
      const key = row.key.trim();
      if (!key) {
        if (row.value) return 'Every Secret entry with a value must have a key.';
        continue;
      }
      if (!K8S_DATA_KEY_PATTERN.test(key) || key.length > 253) {
        return `Invalid Secret key "${key}". Use 1–253 letters, digits, dots, underscores, or hyphens.`;
      }
      if (seen.has(key)) return `Duplicate Secret key "${key}".`;
      seen.add(key);
      if (row.mode === 'base64') {
        try {
          totalBytes += decodeBase64(row.value).length;
        } catch {
          return `Secret key "${key}" has an invalid base64 value.`;
        }
      } else {
        totalBytes += encoder.encode(row.value).length;
      }
      if (totalBytes > 1024 * 1024) return 'Secret data exceeds the 1 MiB Kubernetes limit.';
    }
    return '';
  },
};
