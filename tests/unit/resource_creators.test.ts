/**
 * Unit tests for modular Kubernetes resource creator models (Form <-> YAML sync).
 *
 * Purpose & invariants guarded by this suite:
 * 1. Exact `(group, kind)` registry lookup guarantees CRDs with colliding kinds
 *    (for example `external-secrets.io/Secret`) fall back to the generic YAML
 *    editor instead of applying core Kubernetes form schemas.
 * 2. Every starter template produced by `newResourceTemplate` hydrates cleanly
 *    into its registered creator, serializes back to valid YAML, and passes
 *    `validateNewResource`.
 * 3. Editing fields in Form mode patches the YAML document in place, preserving
 *    comments and unmodeled Kubernetes fields (`nodeSelector`, `volumeMounts`,
 *    `env[].valueFrom`, `binaryData`, etc.) across `YAML -> Form -> YAML` round-trips.
 * 4. Form-level validation catches invalid keys, duplicate keys, malformed base64,
 *    invalid ports, bad cron schedules, and missing required TLS/registry fields
 *    before submission reaches the backend mutation gateway.
 */
import { describe, expect, it } from 'vitest';
import {
  configMapCreatorModel,
  convertSecretCreatorRows,
  cronJobCreatorModel,
  deploymentCreatorModel,
  findCreatorModel,
  ingressCreatorModel,
  jobCreatorModel,
  namespaceCreatorModel,
  podCreatorModel,
  pvcCreatorModel,
  readManifestObject,
  RESOURCE_CREATOR_MODELS,
  secretCreatorModel,
  serviceAccountCreatorModel,
  serviceCreatorModel,
  updateManifestMetadataPairs,
} from '../../src/core/resources/creators';
import { newResourceTemplate, validateNewResource, type NewResourceType } from '../../src/core/resources/new_resource';
import { decodeBase64, encodeText } from '../../src/core/resources/secret_data';
import { resourceType } from '../../src/core/resources/resource_types';

function parseOrThrow(manifest: string): Record<string, any> {
  const result = readManifestObject(manifest);
  if (!result.ok) throw new Error(result.error);
  return result.object;
}

describe('resource creator registry and YAML fallback', () => {
  it('resolves all 11 built-in creators and falls back to undefined for unsupported kinds and colliding CRDs', () => {
    const expectedKinds = [
      'Secret',
      'ConfigMap',
      'Namespace',
      'ServiceAccount',
      'Deployment',
      'Pod',
      'Service',
      'Ingress',
      'PersistentVolumeClaim',
      'Job',
      'CronJob',
    ] as const;

    for (const kind of expectedKinds) {
      const type = resourceType(kind);
      expect(findCreatorModel(type), `creator for ${kind}`).toBeDefined();
    }

    // Core kinds without dedicated forms must fall back cleanly to YAML.
    expect(findCreatorModel(resourceType('DaemonSet'))).toBeUndefined();
    expect(findCreatorModel(resourceType('Role'))).toBeUndefined();
    expect(findCreatorModel(resourceType('NetworkPolicy'))).toBeUndefined();
    expect(findCreatorModel(resourceType('HorizontalPodAutoscaler'))).toBeUndefined();

    // CRDs with colliding Kind names must NEVER match core forms.
    expect(findCreatorModel({ group: 'external-secrets.io', kind: 'Secret' })).toBeUndefined();
    expect(findCreatorModel({ group: 'serving.knative.dev', kind: 'Service' })).toBeUndefined();
    expect(findCreatorModel({ group: 'example.io', kind: 'Deployment' })).toBeUndefined();
  });

  it('round-trips every registered starter template cleanly through fromObject -> applyToManifest -> validateNewResource', () => {
    for (const model of RESOURCE_CREATOR_MODELS) {
      const type = resourceType(model.kind as any) as NewResourceType;
      const starter = newResourceTemplate(type, `sample-${type.kind.toLowerCase()}`, 'apps');
      const obj = parseOrThrow(starter);
      const state = model.fromObject(obj, type);
      expect(model.validate(state, type), `initial validation for ${model.kind}`).toBe('');
      const patched = model.applyToManifest(starter, state, type);
      expect(() => validateNewResource(patched, type)).not.toThrow();
    }
  });
});

describe('Secret creator model', () => {
  const type = resourceType('Secret');
  const starter = newResourceTemplate(type, 'app-secret', 'apps');

  it('writes Opaque text rows to stringData and base64/binary rows to data while enforcing validation', () => {
    const initial = secretCreatorModel.fromObject(parseOrThrow(starter), type);
    const updated = {
      ...initial,
      immutable: true,
      rows: [
        { id: 1, key: 'DB_PASSWORD', value: 's3cr3t!', mode: 'text' as const },
        { id: 2, key: 'RAW_BYTES', value: encodeText('bin'), mode: 'base64' as const },
      ],
    };
    expect(secretCreatorModel.validate(updated, type)).toBe('');
    const yaml = secretCreatorModel.applyToManifest(starter, updated, type);
    const obj = validateNewResource(yaml, type);
    expect(obj.type).toBe('Opaque');
    expect(obj.immutable).toBe(true);
    expect(obj.stringData).toEqual({ DB_PASSWORD: 's3cr3t!' });
    expect(obj.data).toEqual({ RAW_BYTES: encodeText('bin') });

    // Round-trip back to Form keeps both keys.
    const hydrated = secretCreatorModel.fromObject(obj, type);
    expect(hydrated.immutable).toBe(true);
    expect(hydrated.rows.map((r) => [r.key, r.value])).toEqual([
      ['RAW_BYTES', 'bin'],
      ['DB_PASSWORD', 's3cr3t!'],
    ]);

    // Validation catches duplicate keys and malformed base64.
    expect(secretCreatorModel.validate({
      ...updated,
      rows: [
        { id: 1, key: 'DUP', value: 'a', mode: 'text' },
        { id: 2, key: 'DUP', value: 'b', mode: 'text' },
      ],
    }, type)).toContain('Duplicate Secret key');
    expect(secretCreatorModel.validate({
      ...updated,
      rows: [{ id: 1, key: 'BAD', value: 'not-base64!!!', mode: 'base64' }],
    }, type)).toContain('invalid base64');
  });

  it('converts UTF-8 rows between Text and Base64 while preserving non-UTF8 binary rows in Base64', () => {
    const nonUtf8Base64 = btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0x80));
    const rows = [
      { id: 1, key: 'TOKEN', value: 'hello', mode: 'text' as const },
      { id: 2, key: 'KEYSTORE', value: nonUtf8Base64, mode: 'base64' as const },
    ];
    const asBase64 = convertSecretCreatorRows(rows, 'base64');
    expect(asBase64[0]).toMatchObject({ mode: 'base64', value: encodeText('hello') });
    const backToText = convertSecretCreatorRows(asBase64, 'text');
    expect(backToText[0]).toMatchObject({ mode: 'text', value: 'hello' });
    expect(backToText[1]).toMatchObject({ mode: 'base64', value: nonUtf8Base64 });
  });

  it('generates and round-trips dockerconfigjson, tls, basic-auth, ssh-auth, and custom secrets', () => {
    const base = secretCreatorModel.fromObject(parseOrThrow(starter), type);

    // dockerconfigjson
    const dockerState = {
      ...base,
      typePreset: 'kubernetes.io/dockerconfigjson' as const,
      dockerServer: 'ghcr.io',
      dockerUsername: 'bot',
      dockerPassword: 'ghp_token',
      dockerEmail: 'bot@example.com',
    };
    expect(secretCreatorModel.validate(dockerState, type)).toBe('');
    const dockerYaml = secretCreatorModel.applyToManifest(starter, dockerState, type);
    const dockerObj = validateNewResource(dockerYaml, type);
    expect(dockerObj.type).toBe('kubernetes.io/dockerconfigjson');
    expect(dockerObj.stringData).toBeUndefined();
    const decodedJson = JSON.parse(new TextDecoder().decode(decodeBase64(dockerObj.data['.dockerconfigjson'])));
    expect(decodedJson.auths['ghcr.io']).toMatchObject({
      username: 'bot',
      password: 'ghp_token',
      email: 'bot@example.com',
      auth: encodeText('bot:ghp_token'),
    });
    const rehydratedDocker = secretCreatorModel.fromObject(dockerObj, type);
    expect(rehydratedDocker.typePreset).toBe('kubernetes.io/dockerconfigjson');
    expect(rehydratedDocker.dockerServer).toBe('ghcr.io');
    expect(rehydratedDocker.dockerUsername).toBe('bot');
    expect(rehydratedDocker.dockerPassword).toBe('ghp_token');

    // TLS validation & serialization
    const emptyTls = { ...base, typePreset: 'kubernetes.io/tls' as const, tlsCrt: '', tlsKey: '' };
    expect(secretCreatorModel.validate(emptyTls, type)).toContain('tls.crt');
    const validTls = { ...emptyTls, tlsCrt: 'CERT-DATA', tlsKey: 'KEY-DATA' };
    const tlsObj = validateNewResource(secretCreatorModel.applyToManifest(starter, validTls, type), type);
    expect(tlsObj.type).toBe('kubernetes.io/tls');
    expect(tlsObj.stringData).toEqual({ 'tls.crt': 'CERT-DATA', 'tls.key': 'KEY-DATA' });

    // Basic Auth & SSH Auth
    const basicObj = validateNewResource(
      secretCreatorModel.applyToManifest(starter, { ...base, typePreset: 'kubernetes.io/basic-auth', basicUsername: 'u', basicPassword: 'p' }, type),
      type,
    );
    expect(basicObj.stringData).toEqual({ username: 'u', password: 'p' });

    const sshObj = validateNewResource(
      secretCreatorModel.applyToManifest(starter, { ...base, typePreset: 'kubernetes.io/ssh-auth', sshPrivateKey: 'SSH-KEY' }, type),
      type,
    );
    expect(sshObj.stringData).toEqual({ 'ssh-privatekey': 'SSH-KEY' });

    // Custom type
    const customObj = validateNewResource(
      secretCreatorModel.applyToManifest(starter, {
        ...base,
        typePreset: 'custom',
        customType: 'example.io/token',
        rows: [{ id: 1, key: 'token', value: 'abc', mode: 'text' }],
      }, type),
      type,
    );
    expect(customObj.type).toBe('example.io/token');
    expect(secretCreatorModel.fromObject(customObj, type).typePreset).toBe('custom');
  });
});

describe('ConfigMap, Namespace, and ServiceAccount creators', () => {
  it('ConfigMap edits data and immutable while preserving YAML comments and binaryData', () => {
    const type = resourceType('ConfigMap');
    const yamlWithExtras = `${newResourceTemplate(type, 'cfg', 'apps')}# keep comment\nbinaryData:\n  logo.bin: AAAA\n`;
    const state = configMapCreatorModel.fromObject(parseOrThrow(yamlWithExtras), type);
    const next = {
      ...state,
      immutable: true,
      entries: [{ id: 1, key: 'app.json', value: '{"ok":true}' }],
    };
    const out = configMapCreatorModel.applyToManifest(yamlWithExtras, next, type);
    expect(out).toContain('# keep comment');
    const obj = validateNewResource(out, type);
    expect(obj.immutable).toBe(true);
    expect(obj.data).toEqual({ 'app.json': '{"ok":true}' });
    expect(obj.binaryData).toEqual({ 'logo.bin': 'AAAA' });
  });

  it('Namespace toggles Pod Security enforce label without breaking other metadata labels', () => {
    const type = resourceType('Namespace');
    const starter = updateManifestMetadataPairs(
      newResourceTemplate(type, 'payments', 'ignored'),
      [{ id: 1, key: 'team', value: 'core' }],
      [{ id: 1, key: 'owner', value: 'platform' }],
    );
    const restricted = namespaceCreatorModel.applyToManifest(starter, { podSecurityEnforce: 'restricted' }, type);
    expect(validateNewResource(restricted, type).metadata.labels).toEqual({
      team: 'core',
      'pod-security.kubernetes.io/enforce': 'restricted',
    });
    const cleared = namespaceCreatorModel.applyToManifest(restricted, { podSecurityEnforce: '' }, type);
    expect(validateNewResource(cleared, type).metadata.labels).toEqual({ team: 'core' });
  });

  it('ServiceAccount serializes automountServiceAccountToken and deduplicated imagePullSecrets', () => {
    const type = resourceType('ServiceAccount');
    const starter = newResourceTemplate(type, 'runner', 'apps');
    const state = {
      automountToken: 'false' as const,
      imagePullSecrets: [{ id: 1, name: 'regcred' }, { id: 2, name: 'ghcr-auth' }],
    };
    expect(serviceAccountCreatorModel.validate(state, type)).toBe('');
    const obj = validateNewResource(serviceAccountCreatorModel.applyToManifest(starter, state, type), type);
    expect(obj.automountServiceAccountToken).toBe(false);
    expect(obj.imagePullSecrets).toEqual([{ name: 'regcred' }, { name: 'ghcr-auth' }]);
    expect(serviceAccountCreatorModel.validate({
      automountToken: 'default',
      imagePullSecrets: [{ id: 1, name: 'dup' }, { id: 2, name: 'dup' }],
    }, type)).toContain('Duplicate');
  });
});

describe('Workload creators preserve unmodeled YAML fields across round-trips', () => {
  it('Deployment patches replicas, strategy, selector, and containers without dropping nodeSelector, probes, or valueFrom env', () => {
    const type = resourceType('Deployment');
    const customYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      # pin workload to SSD nodes
      nodeSelector:
        disktype: ssd
      containers:
        - name: api
          image: ghcr.io/acme/api:1.0
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
          env:
            - name: PLAIN
              value: "1"
            - name: SECRET_TOKEN
              valueFrom:
                secretKeyRef:
                  name: api-secret
                  key: token
`;
    const state = deploymentCreatorModel.fromObject(parseOrThrow(customYaml), type);
    expect(state.replicas).toBe('2');
    expect(state.containers[0].env).toEqual([{ id: 1, key: 'PLAIN', value: '1' }]);
    expect(state.containers[0].preservedEnv).toHaveLength(1);

    const edited = {
      ...state,
      replicas: '5',
      strategy: 'Recreate' as const,
      containers: [
        {
          ...state.containers[0],
          image: 'ghcr.io/acme/api:2.0',
          env: [{ id: 1, key: 'PLAIN', value: '2' }],
        },
      ],
    };
    const out = deploymentCreatorModel.applyToManifest(customYaml, edited, type);
    expect(out).toContain('# pin workload to SSD nodes');
    const obj = validateNewResource(out, type);
    expect(obj.spec.replicas).toBe(5);
    expect(obj.spec.strategy).toEqual({ type: 'Recreate' });
    expect(obj.spec.template.spec.nodeSelector).toEqual({ disktype: 'ssd' });
    expect(obj.spec.template.spec.containers[0].image).toBe('ghcr.io/acme/api:2.0');
    expect(obj.spec.template.spec.containers[0].livenessProbe).toEqual({ httpGet: { path: '/healthz', port: 8080 } });
    expect(obj.spec.template.spec.containers[0].env).toEqual([
      { name: 'PLAIN', value: '2' },
      { name: 'SECRET_TOKEN', valueFrom: { secretKeyRef: { name: 'api-secret', key: 'token' } } },
    ]);
  });

  it('Pod, Job, and CronJob validate and serialize their specific spec fields', () => {
    const podType = resourceType('Pod');
    const podYaml = newResourceTemplate(podType, 'debug', 'apps');
    const podState = { ...podCreatorModel.fromObject(parseOrThrow(podYaml), podType), restartPolicy: 'Never' as const, nodeName: 'node-1' };
    const podObj = validateNewResource(podCreatorModel.applyToManifest(podYaml, podState, podType), podType);
    expect(podObj.spec.restartPolicy).toBe('Never');
    expect(podObj.spec.nodeName).toBe('node-1');

    const jobType = resourceType('Job');
    const jobYaml = newResourceTemplate(jobType, 'migrate', 'apps');
    const jobState = { ...jobCreatorModel.fromObject(parseOrThrow(jobYaml), jobType), completions: '2', backoffLimit: '3', ttlSecondsAfterFinished: '600' };
    const jobObj = validateNewResource(jobCreatorModel.applyToManifest(jobYaml, jobState, jobType), jobType);
    expect(jobObj.spec).toMatchObject({ completions: 2, backoffLimit: 3, ttlSecondsAfterFinished: 600 });

    const cronType = resourceType('CronJob');
    const cronYaml = newResourceTemplate(cronType, 'nightly', 'apps');
    const cronState = cronJobCreatorModel.fromObject(parseOrThrow(cronYaml), cronType);
    expect(cronJobCreatorModel.validate({ ...cronState, schedule: 'bad cron' }, cronType)).toContain('5-field cron');
    const cronObj = validateNewResource(
      cronJobCreatorModel.applyToManifest(cronYaml, { ...cronState, schedule: '0 0 * * *', suspend: true }, cronType),
      cronType,
    );
    expect(cronObj.spec.schedule).toBe('0 0 * * *');
    expect(cronObj.spec.suspend).toBe(true);
  });
});

describe('Network and Storage creators (Service, Ingress, PVC)', () => {
  it('Service handles ClusterIP headless, NodePort, ExternalName, and multi-port validation', () => {
    const type = resourceType('Service');
    const starter = newResourceTemplate(type, 'web', 'apps');
    const base = serviceCreatorModel.fromObject(parseOrThrow(starter), type);

    const headlessObj = validateNewResource(
      serviceCreatorModel.applyToManifest(starter, { ...base, serviceType: 'ClusterIP', headless: true }, type),
      type,
    );
    expect(headlessObj.spec.clusterIP).toBe('None');

    const extObj = validateNewResource(
      serviceCreatorModel.applyToManifest(starter, { ...base, serviceType: 'ExternalName', externalName: 'db.internal.example' }, type),
      type,
    );
    expect(extObj.spec.type).toBe('ExternalName');
    expect(extObj.spec.externalName).toBe('db.internal.example');
    expect(extObj.spec.ports).toBeUndefined();

    // Multi-port Service requires port names.
    expect(serviceCreatorModel.validate({
      ...base,
      ports: [
        { id: 1, name: '', protocol: 'TCP', port: '80', targetPort: '80', nodePort: '' },
        { id: 2, name: 'metrics', protocol: 'TCP', port: '9090', targetPort: '9090', nodePort: '' },
      ],
    }, type)).toContain('require a name');
  });

  it('Ingress serializes class, rules with numeric/named ports, and TLS secrets', () => {
    const type = resourceType('Ingress');
    const starter = newResourceTemplate(type, 'gateway', 'apps');
    const state = {
      ingressClassName: 'nginx',
      rules: [
        {
          id: 1,
          host: 'api.example.com',
          paths: [
            { id: 1, path: '/', pathType: 'Prefix' as const, serviceName: 'web', servicePort: '80' },
            { id: 2, path: '/grpc', pathType: 'Exact' as const, serviceName: 'api', servicePort: 'grpc' },
          ],
        },
      ],
      tls: [{ id: 1, secretName: 'api-tls', hosts: 'api.example.com, www.example.com' }],
    };
    expect(ingressCreatorModel.validate(state, type)).toBe('');
    const obj = validateNewResource(ingressCreatorModel.applyToManifest(starter, state, type), type);
    expect(obj.spec.ingressClassName).toBe('nginx');
    expect(obj.spec.rules[0].http.paths[0].backend.service).toEqual({ name: 'web', port: { number: 80 } });
    expect(obj.spec.rules[0].http.paths[1].backend.service).toEqual({ name: 'api', port: { name: 'grpc' } });
    expect(obj.spec.tls).toEqual([{ hosts: ['api.example.com', 'www.example.com'], secretName: 'api-tls' }]);
  });

  it('PersistentVolumeClaim validates storage quantities and access modes', () => {
    const type = resourceType('PersistentVolumeClaim');
    const starter = newResourceTemplate(type, 'pg-data', 'apps');
    const base = pvcCreatorModel.fromObject(parseOrThrow(starter), type);
    expect(pvcCreatorModel.validate({ ...base, storage: 'not-a-size' }, type)).toContain('Invalid storage quantity');
    expect(pvcCreatorModel.validate({ ...base, accessModes: [] }, type)).toContain('access mode');

    const obj = validateNewResource(
      pvcCreatorModel.applyToManifest(starter, {
        storage: '50Gi',
        storageClassName: 'gp3',
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Block',
      }, type),
      type,
    );
    expect(obj.spec).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '50Gi' } },
      storageClassName: 'gp3',
      volumeMode: 'Block',
    });
  });
});
