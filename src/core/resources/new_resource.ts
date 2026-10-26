import { parseDocument, stringify } from 'yaml';
import type { GroupVersionKind } from './resource_types';
import { apiVersionFor } from './resource_types';

export type NewResourceType = GroupVersionKind & { namespaced: boolean };
const namespaceName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
export function resourceNameValid(name: string, kind: string): boolean {
  if (!name || name.length > 253) return false;
  return ['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'].includes(kind)
    ? /^[a-zA-Z0-9._:-]+$/.test(name) && name !== '.' && name !== '..'
    : name.split('.').every(label => namespaceName.test(label));
}

/** Starter manifests are editable; API admission remains the schema authority. */
export function newResourceTemplate(type: NewResourceType, name: string, namespace: string): string {
  const object: Record<string, any> = { apiVersion: apiVersionFor(type), kind: type.kind, metadata: { name, ...(type.namespaced ? { namespace } : {}) } };
  const labels = { app: name };
  const podSpec = { containers: [{ name: 'app', image: 'nginx:stable-alpine', ports: [{ containerPort: 80 }], resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '128Mi' } } }] };
  const template = { metadata: { labels }, spec: podSpec };
  switch (type.kind) {
    case 'Pod': object.metadata.labels = labels; object.spec = podSpec; break;
    case 'Deployment': case 'StatefulSet': case 'ReplicaSet': case 'DaemonSet':
      object.spec = { ...(type.kind !== 'DaemonSet' ? { replicas: 1 } : {}), ...(type.kind === 'StatefulSet' ? { serviceName: name } : {}), selector: { matchLabels: labels }, template }; break;
    case 'Job': case 'CronJob': {
      const job = { template: { metadata: { labels }, spec: { restartPolicy: 'Never', containers: [{ name: 'task', image: 'busybox:stable', command: ['sh', '-c', 'echo Hello from Kubiki'] }] } } };
      object.spec = type.kind === 'CronJob' ? { schedule: '0 * * * *', concurrencyPolicy: 'Forbid', jobTemplate: { spec: job } } : job; break;
    }
    case 'Service': object.spec = { selector: labels, ports: [{ name: 'http', port: 80, targetPort: 80 }], type: 'ClusterIP' }; break;
    case 'ConfigMap': object.data = { 'config.yaml': '# Add configuration here\n' }; break;
    case 'Secret': object.type = 'Opaque'; object.stringData = {}; break;
    case 'Namespace': case 'ServiceAccount': break;
    case 'Role': case 'ClusterRole': object.rules = []; break;
    case 'RoleBinding': case 'ClusterRoleBinding': object.roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: type.kind === 'RoleBinding' ? 'Role' : 'ClusterRole', name }; object.subjects = [{ kind: 'ServiceAccount', name: 'default', namespace: namespace || 'default' }]; break;
    case 'PersistentVolumeClaim': object.spec = { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }; break;
    case 'Ingress': object.spec = { rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 80 } } } }] } }] }; break;
    case 'NetworkPolicy': object.spec = { podSelector: { matchLabels: labels }, policyTypes: ['Ingress'], ingress: [{}] }; break;
    case 'PodDisruptionBudget': object.spec = { maxUnavailable: 1, selector: { matchLabels: labels } }; break;
    case 'HorizontalPodAutoscaler': object.spec = { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name }, minReplicas: 1, maxReplicas: 3, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }] }; break;
    default: object.spec = {};
  }
  return stringify(object, { aliasDuplicateObjects: false }) + (object.spec && !Object.keys(object.spec).length ? '# Complete the spec for this resource before creating it.\n' : '');
}

/** Metadata edits preserve the user's spec and YAML comments. */
export function updateNewResourceIdentity(manifest: string, name: string, namespace: string, namespaced: boolean): string {
  const document = parseDocument(manifest);
  if (document.errors.length) throw new Error('Fix the YAML syntax before changing the name or namespace.');
  document.setIn(['metadata', 'name'], name);
  if (namespaced) document.setIn(['metadata', 'namespace'], namespace);
  return document.toString();
}

export function validateNewResource(manifest: string, type: NewResourceType): Record<string, any> {
  if (new TextEncoder().encode(manifest).length > 1024 * 1024) throw new Error('Manifest exceeds 1 MiB.');
  const document = parseDocument(manifest);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const object = document.toJS({ maxAliasCount: 50 });
  if (!object || Array.isArray(object) || typeof object !== 'object') throw new Error('Enter one Kubernetes object as YAML.');
  if (object.kind !== type.kind || object.apiVersion !== apiVersionFor(type)) throw new Error(`Expected ${apiVersionFor(type)} / ${type.kind}. Open the matching resource list to create a different kind.`);
  if (typeof object.metadata?.name !== 'string' || !resourceNameValid(object.metadata.name, type.kind)) throw new Error('metadata.name must be a valid resource name (up to 253 characters, with no trailing dash).');
  const namespace = object.metadata.namespace;
  if (type.namespaced && (typeof namespace !== 'string' || namespace.length > 63 || !namespaceName.test(namespace) || namespace === 'all')) throw new Error('Set metadata.namespace to one namespace (lowercase letters, digits and dashes, up to 63 characters).');
  if (!type.namespaced && namespace !== undefined) throw new Error(`${type.kind} is cluster-scoped. Remove metadata.namespace.`);
  if (['uid', 'resourceVersion', 'managedFields', 'creationTimestamp', 'deletionTimestamp', 'generateName'].some(key => object.metadata[key] !== undefined) || object.status !== undefined) throw new Error('A new object cannot include server-owned metadata, generateName or status.');
  return object;
}
