import {
  deletePath,
  entriesToRecord,
  parseOptionalInt,
  patchManifest,
  readStringEntries,
  setOptionalString,
  setPath,
  validateKeyValueEntries,
} from './manifest_helpers';
import { PORT_PROTOCOLS, type PortProtocol } from './workload_creators';
import type { KeyValueEntry, ResourceCreatorModel } from './types';

/* ============================ Service ============================ */

export const SERVICE_TYPES = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'] as const;
export type ServiceTypeOption = (typeof SERVICE_TYPES)[number];

export interface ServicePortDraft {
  id: number;
  name: string;
  protocol: PortProtocol;
  port: string;
  targetPort: string;
  nodePort: string;
}

export interface ServiceCreatorState {
  serviceType: ServiceTypeOption;
  headless: boolean;
  externalName: string;
  sessionAffinity: 'None' | 'ClientIP';
  selector: KeyValueEntry[];
  ports: ServicePortDraft[];
}

export const serviceCreatorModel: ResourceCreatorModel<ServiceCreatorState> = {
  group: '',
  kind: 'Service',
  description: 'Expose Pods internally or externally through a stable network endpoint.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const serviceType: ServiceTypeOption = SERVICE_TYPES.includes(spec.type) ? spec.type : 'ClusterIP';
    const rawPorts = Array.isArray(spec.ports) ? spec.ports : [];
    const ports: ServicePortDraft[] = rawPorts.map((p: any, idx: number) => ({
      id: idx + 1,
      name: typeof p?.name === 'string' ? p.name : '',
      protocol: PORT_PROTOCOLS.includes(p?.protocol) ? p.protocol : 'TCP',
      port: p?.port !== undefined && p?.port !== null ? String(p.port) : '',
      targetPort: p?.targetPort !== undefined && p?.targetPort !== null ? String(p.targetPort) : '',
      nodePort: p?.nodePort !== undefined && p?.nodePort !== null ? String(p.nodePort) : '',
    }));
    return {
      serviceType,
      headless: serviceType === 'ClusterIP' && spec.clusterIP === 'None',
      externalName: typeof spec.externalName === 'string' ? spec.externalName : '',
      sessionAffinity: spec.sessionAffinity === 'ClientIP' ? 'ClientIP' : 'None',
      selector: readStringEntries(spec.selector),
      ports: ports.length ? ports : [{ id: 1, name: 'http', protocol: 'TCP', port: '80', targetPort: '80', nodePort: '' }],
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      setPath(doc, ['spec', 'type'], state.serviceType);

      if (state.serviceType === 'ExternalName') {
        setOptionalString(doc, ['spec', 'externalName'], state.externalName);
        deletePath(doc, ['spec', 'clusterIP']);
        deletePath(doc, ['spec', 'selector']);
        deletePath(doc, ['spec', 'ports']);
        deletePath(doc, ['spec', 'sessionAffinity']);
        return;
      }

      deletePath(doc, ['spec', 'externalName']);
      if (state.serviceType === 'ClusterIP' && state.headless) {
        setPath(doc, ['spec', 'clusterIP'], 'None');
      } else {
        deletePath(doc, ['spec', 'clusterIP']);
      }

      if (state.sessionAffinity === 'ClientIP') setPath(doc, ['spec', 'sessionAffinity'], 'ClientIP');
      else deletePath(doc, ['spec', 'sessionAffinity']);

      const selectorRecord = entriesToRecord(state.selector);
      if (Object.keys(selectorRecord).length) setPath(doc, ['spec', 'selector'], selectorRecord);
      else deletePath(doc, ['spec', 'selector']);

      const ports = state.ports
        .map((p) => {
          const port = parseOptionalInt(p.port);
          if (typeof port !== 'number' || port < 1 || port > 65535) return null;
          const out: Record<string, unknown> = { port };
          if (p.name.trim()) out.name = p.name.trim();
          if (p.protocol !== 'TCP') out.protocol = p.protocol;
          if (p.targetPort.trim()) {
            const targetInt = parseOptionalInt(p.targetPort);
            out.targetPort = typeof targetInt === 'number' ? targetInt : p.targetPort.trim();
          }
          if (state.serviceType === 'NodePort' || state.serviceType === 'LoadBalancer') {
            const nodePort = parseOptionalInt(p.nodePort);
            if (typeof nodePort === 'number') out.nodePort = nodePort;
          }
          return out;
        })
        .filter((p): p is Record<string, unknown> => p !== null);
      if (ports.length) setPath(doc, ['spec', 'ports'], ports);
      else deletePath(doc, ['spec', 'ports']);
    });
  },

  validate(state) {
    if (state.serviceType === 'ExternalName') {
      if (!state.externalName.trim()) return 'ExternalName Service requires an external DNS name.';
      return '';
    }
    const selectorErr = validateKeyValueEntries(state.selector, 'Service selector');
    if (selectorErr) return selectorErr;
    if (!state.ports.length) return 'Add at least one Service port.';
    const names = new Set<string>();
    for (let i = 0; i < state.ports.length; i += 1) {
      const p = state.ports[i];
      const port = parseOptionalInt(p.port);
      if (typeof port !== 'number' || port < 1 || port > 65535) {
        return `Port #${i + 1}: port must be an integer between 1 and 65535.`;
      }
      if (state.ports.length > 1 && !p.name.trim()) {
        return `Port #${i + 1}: multi-port Services require a name for each port.`;
      }
      if (p.name.trim()) {
        if (names.has(p.name.trim())) return `Duplicate Service port name "${p.name.trim()}".`;
        names.add(p.name.trim());
      }
      if (p.targetPort.trim()) {
        const targetInt = parseOptionalInt(p.targetPort);
        if (typeof targetInt === 'number' && (targetInt < 1 || targetInt > 65535)) {
          return `Port #${i + 1}: numeric targetPort must be between 1 and 65535.`;
        }
      }
      if ((state.serviceType === 'NodePort' || state.serviceType === 'LoadBalancer') && p.nodePort.trim()) {
        const nodePort = parseOptionalInt(p.nodePort);
        if (typeof nodePort !== 'number' || nodePort < 1 || nodePort > 65535) {
          return `Port #${i + 1}: nodePort must be an integer between 1 and 65535.`;
        }
      }
    }
    return '';
  },
};

/* ============================ Ingress ============================ */

export const INGRESS_PATH_TYPES = ['Prefix', 'Exact', 'ImplementationSpecific'] as const;
export type IngressPathType = (typeof INGRESS_PATH_TYPES)[number];

export interface IngressPathDraft {
  id: number;
  path: string;
  pathType: IngressPathType;
  serviceName: string;
  servicePort: string;
}

export interface IngressRuleDraft {
  id: number;
  host: string;
  paths: IngressPathDraft[];
}

export interface IngressTlsDraft {
  id: number;
  secretName: string;
  hosts: string;
}

export interface IngressCreatorState {
  ingressClassName: string;
  rules: IngressRuleDraft[];
  tls: IngressTlsDraft[];
}

export const ingressCreatorModel: ResourceCreatorModel<IngressCreatorState> = {
  group: 'networking.k8s.io',
  kind: 'Ingress',
  description: 'Route external HTTP/HTTPS traffic to cluster Services with optional TLS.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const rawRules = Array.isArray(spec.rules) ? spec.rules : [];
    const rules: IngressRuleDraft[] = rawRules.map((rule: any, rIdx: number) => {
      const rawPaths = Array.isArray(rule?.http?.paths) ? rule.http.paths : [];
      const paths: IngressPathDraft[] = rawPaths.map((p: any, pIdx: number) => {
        const backendPort = p?.backend?.service?.port;
        const servicePort = backendPort?.number !== undefined ? String(backendPort.number) : typeof backendPort?.name === 'string' ? backendPort.name : '80';
        return {
          id: pIdx + 1,
          path: typeof p?.path === 'string' ? p.path : '/',
          pathType: INGRESS_PATH_TYPES.includes(p?.pathType) ? p.pathType : 'Prefix',
          serviceName: typeof p?.backend?.service?.name === 'string' ? p.backend.service.name : '',
          servicePort,
        };
      });
      return {
        id: rIdx + 1,
        host: typeof rule?.host === 'string' ? rule.host : '',
        paths: paths.length ? paths : [{ id: 1, path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }],
      };
    });

    const rawTls = Array.isArray(spec.tls) ? spec.tls : [];
    const tls: IngressTlsDraft[] = rawTls.map((entry: any, tIdx: number) => ({
      id: tIdx + 1,
      secretName: typeof entry?.secretName === 'string' ? entry.secretName : '',
      hosts: Array.isArray(entry?.hosts) ? entry.hosts.map(String).join(', ') : '',
    }));

    return {
      ingressClassName: typeof spec.ingressClassName === 'string' ? spec.ingressClassName : '',
      rules: rules.length ? rules : [{
        id: 1,
        host: 'app.example.com',
        paths: [{ id: 1, path: '/', pathType: 'Prefix', serviceName: typeof object?.metadata?.name === 'string' ? object.metadata.name : 'my-ingress', servicePort: '80' }],
      }],
      tls,
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      setOptionalString(doc, ['spec', 'ingressClassName'], state.ingressClassName);

      const rules = state.rules.map((rule) => {
        const paths = rule.paths.map((p) => {
          const portInt = parseOptionalInt(p.servicePort);
          const portObj = typeof portInt === 'number' ? { number: portInt } : { name: p.servicePort.trim() };
          return {
            path: p.path.trim() || '/',
            pathType: p.pathType,
            backend: {
              service: {
                name: p.serviceName.trim(),
                port: portObj,
              },
            },
          };
        });
        const entry: Record<string, unknown> = { http: { paths } };
        if (rule.host.trim()) entry.host = rule.host.trim();
        return entry;
      });
      if (rules.length) setPath(doc, ['spec', 'rules'], rules);
      else deletePath(doc, ['spec', 'rules']);

      const tls = state.tls
        .map((entry) => {
          const hosts = entry.hosts.split(',').map((h) => h.trim()).filter(Boolean);
          const secretName = entry.secretName.trim();
          if (!secretName && !hosts.length) return null;
          return {
            ...(hosts.length ? { hosts } : {}),
            ...(secretName ? { secretName } : {}),
          };
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      if (tls.length) setPath(doc, ['spec', 'tls'], tls);
      else deletePath(doc, ['spec', 'tls']);
    });
  },

  validate(state) {
    if (!state.rules.length) return 'Ingress requires at least one routing rule.';
    for (let i = 0; i < state.rules.length; i += 1) {
      const rule = state.rules[i];
      if (!rule.paths.length) return `Rule #${i + 1}: add at least one HTTP path.`;
      for (let j = 0; j < rule.paths.length; j += 1) {
        const p = rule.paths[j];
        if (!p.path.trim().startsWith('/')) return `Rule #${i + 1}, Path #${j + 1}: path must start with "/".`;
        if (!p.serviceName.trim()) return `Rule #${i + 1}, Path #${j + 1}: enter a backend Service name.`;
        if (!p.servicePort.trim()) return `Rule #${i + 1}, Path #${j + 1}: enter a backend Service port number or name.`;
        const portInt = parseOptionalInt(p.servicePort);
        if (typeof portInt === 'number' && (portInt < 1 || portInt > 65535)) {
          return `Rule #${i + 1}, Path #${j + 1}: numeric Service port must be between 1 and 65535.`;
        }
      }
    }
    return '';
  },
};

/* ============================ PersistentVolumeClaim ============================ */

export const PVC_ACCESS_MODES = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'] as const;
export type PvcAccessMode = (typeof PVC_ACCESS_MODES)[number];

export const PVC_VOLUME_MODES = ['Filesystem', 'Block'] as const;
export type PvcVolumeMode = (typeof PVC_VOLUME_MODES)[number];

export interface PvcCreatorState {
  storage: string;
  storageClassName: string;
  accessModes: PvcAccessMode[];
  volumeMode: PvcVolumeMode;
}

const STORAGE_QUANTITY_PATTERN = /^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E|k)?$/;

export const pvcCreatorModel: ResourceCreatorModel<PvcCreatorState> = {
  group: '',
  kind: 'PersistentVolumeClaim',
  description: 'Request persistent block or filesystem storage from the cluster.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const rawModes = Array.isArray(spec.accessModes) ? spec.accessModes : [];
    const accessModes = rawModes.filter((mode: unknown): mode is PvcAccessMode =>
      typeof mode === 'string' && PVC_ACCESS_MODES.includes(mode as PvcAccessMode),
    );
    const volumeMode: PvcVolumeMode = spec.volumeMode === 'Block' ? 'Block' : 'Filesystem';
    return {
      storage: typeof spec?.resources?.requests?.storage === 'string' ? spec.resources.requests.storage : '1Gi',
      storageClassName: typeof spec.storageClassName === 'string' ? spec.storageClassName : '',
      accessModes: accessModes.length ? accessModes : ['ReadWriteOnce'],
      volumeMode,
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      setPath(doc, ['spec', 'accessModes'], state.accessModes);
      setPath(doc, ['spec', 'resources', 'requests', 'storage'], state.storage.trim());
      setOptionalString(doc, ['spec', 'storageClassName'], state.storageClassName);
      if (state.volumeMode === 'Block') setPath(doc, ['spec', 'volumeMode'], 'Block');
      else deletePath(doc, ['spec', 'volumeMode']);
    });
  },

  validate(state) {
    if (!state.accessModes.length) return 'Select at least one access mode (for example, ReadWriteOnce).';
    const size = state.storage.trim();
    if (!size) return 'Enter a storage size (for example, 1Gi or 10Gi).';
    if (!STORAGE_QUANTITY_PATTERN.test(size)) {
      return `Invalid storage quantity "${size}". Examples: 512Mi, 1Gi, 10Gi.`;
    }
    return '';
  },
};
