/** Discovery and list/watch fixtures must describe the same namespaces. */
export function namespaceList(names: string[]) {
  return { items: names.map(name => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: `namespace-${name}`, name } })) };
}
