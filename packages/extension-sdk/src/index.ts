export const HOST_API = '1.0.0';
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Capability = 'settings' | 'secrets' | 'notifications';
export interface ExtensionManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  hostApi: string;
  main: string;
  contributes: {
    panels: { id: string; title: string; entry: string }[];
    commands?: { id: string; title: string; method: string }[];
  };
  requestedCapabilities: Capability[];
}
export interface Disposable {
  dispose(): void | Promise<void>;
}
export interface ExtensionContext {
  settings: {
    get(key: string): Promise<Json>;
    set(key: string, value: Json): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  notify(message: string): Promise<void>;
  subscriptions: Disposable[];
}
export interface CallContext {
  signal: AbortSignal;
}
export interface ExtensionBackend {
  methods: Record<
    string,
    (params: Json, context: CallContext) => Json | Promise<Json>
  >;
  deactivate?(): void | Promise<void>;
}
export type Activate = (
  context: ExtensionContext,
) => ExtensionBackend | Promise<ExtensionBackend>;
export const defineExtension = (activate: Activate): Activate => activate;

export function packagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 240 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          !!part && part !== '.' && part !== '..' && !/[\x00-\x1f]/.test(part),
      )
  );
}
export function validateManifest(value: unknown): ExtensionManifest {
  const m = value as ExtensionManifest;
  const text = (s: unknown, max: number) =>
    typeof s === 'string' &&
    s.trim().length > 0 &&
    s.length <= max &&
    !/[\x00-\x1f]/.test(s);
  if (
    !m ||
    m.manifestVersion !== 1 ||
    !text(m.id, 120) ||
    !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(m.id) ||
    !text(m.name, 80) ||
    !text(m.description, 500) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version) ||
    !text(m.hostApi, 80) ||
    !packagePath(m.main) ||
    !m.main.endsWith('.cjs') ||
    !Array.isArray(m.contributes?.panels) ||
    m.contributes.panels.length < 1 ||
    m.contributes.panels.length > 8 ||
    !Array.isArray(m.requestedCapabilities) ||
    m.requestedCapabilities.some(
      (c) => !['settings', 'secrets', 'notifications'].includes(c),
    )
  )
    throw new Error('Invalid extension manifest');
  const ids = new Set<string>();
  for (const panel of m.contributes.panels) {
    if (
      !text(panel.id, 60) ||
      !/^[a-z][a-z0-9-]*$/.test(panel.id) ||
      ids.has(panel.id) ||
      !text(panel.title, 80) ||
      !packagePath(panel.entry) ||
      !panel.entry.endsWith('.html')
    )
      throw new Error('Invalid or duplicate panel contribution');
    ids.add(panel.id);
  }
  if (
    m.contributes.commands !== undefined &&
    (!Array.isArray(m.contributes.commands) ||
      m.contributes.commands.length > 20)
  )
    throw new Error('Invalid commands');
  const commands = new Set<string>();
  for (const command of m.contributes.commands ?? []) {
    if (
      !text(command.id, 80) ||
      !/^[a-z][a-z0-9.-]*$/.test(command.id) ||
      commands.has(command.id) ||
      !text(command.title, 100) ||
      !/^[a-z][a-zA-Z0-9.]*$/.test(command.method)
    )
      throw new Error('Invalid command contribution');
    commands.add(command.id);
  }
  return m;
}
