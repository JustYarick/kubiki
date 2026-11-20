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
import type { KeyValueEntry, ResourceCreatorModel } from './types';

export const IMAGE_PULL_POLICIES = ['', 'IfNotPresent', 'Always', 'Never'] as const;
export type ImagePullPolicy = (typeof IMAGE_PULL_POLICIES)[number];

export const PORT_PROTOCOLS = ['TCP', 'UDP', 'SCTP'] as const;
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];

export interface ContainerPortDraft {
  id: number;
  name: string;
  containerPort: string;
  protocol: PortProtocol;
}

export interface ContainerDraft {
  id: number;
  name: string;
  image: string;
  imagePullPolicy: ImagePullPolicy;
  command: string;
  args: string;
  ports: ContainerPortDraft[];
  env: KeyValueEntry[];
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  /** Unmodeled container fields (volumeMounts, probes, securityContext, etc.) preserved across edits. */
  preservedFields?: Record<string, unknown>;
  /** Env entries using valueFrom (ConfigMap/Secret/Field refs) preserved across edits. */
  preservedEnv?: Record<string, unknown>[];
}

const MODELED_CONTAINER_KEYS = new Set([
  'name',
  'image',
  'imagePullPolicy',
  'command',
  'args',
  'ports',
  'env',
  'resources',
]);

function splitCommandLine(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function readContainers(rawList: unknown, fallbackName = 'app', fallbackImage = 'nginx:stable-alpine'): ContainerDraft[] {
  const list = Array.isArray(rawList) ? rawList : [];
  if (!list.length) {
    return [{
      id: 1,
      name: fallbackName,
      image: fallbackImage,
      imagePullPolicy: '',
      command: '',
      args: '',
      ports: [],
      env: [],
      cpuRequest: '',
      memoryRequest: '',
      cpuLimit: '',
      memoryLimit: '',
    }];
  }
  return list.map((raw: any, index: number) => {
    const preservedFields: Record<string, unknown> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (!MODELED_CONTAINER_KEYS.has(k)) preservedFields[k] = v;
      }
    }
    const rawPorts = Array.isArray(raw?.ports) ? raw.ports : [];
    const ports: ContainerPortDraft[] = rawPorts.map((p: any, pIdx: number) => ({
      id: pIdx + 1,
      name: typeof p?.name === 'string' ? p.name : '',
      containerPort: p?.containerPort !== undefined && p?.containerPort !== null ? String(p.containerPort) : '',
      protocol: PORT_PROTOCOLS.includes(p?.protocol) ? p.protocol : 'TCP',
    }));

    const rawEnv = Array.isArray(raw?.env) ? raw.env : [];
    const env: KeyValueEntry[] = [];
    const preservedEnv: Record<string, unknown>[] = [];
    let envId = 1;
    for (const item of rawEnv) {
      if (item && typeof item === 'object' && 'valueFrom' in item) {
        preservedEnv.push(item as Record<string, unknown>);
      } else if (item && typeof item === 'object' && typeof item.name === 'string') {
        env.push({ id: envId++, key: item.name, value: item.value === undefined || item.value === null ? '' : String(item.value) });
      }
    }

    const rawPolicy = raw?.imagePullPolicy;
    const imagePullPolicy: ImagePullPolicy = IMAGE_PULL_POLICIES.includes(rawPolicy) ? rawPolicy : '';

    return {
      id: index + 1,
      name: typeof raw?.name === 'string' ? raw.name : '',
      image: typeof raw?.image === 'string' ? raw.image : '',
      imagePullPolicy,
      command: Array.isArray(raw?.command) ? raw.command.map(String).join('\n') : '',
      args: Array.isArray(raw?.args) ? raw.args.map(String).join('\n') : '',
      ports,
      env,
      cpuRequest: typeof raw?.resources?.requests?.cpu === 'string' ? raw.resources.requests.cpu : '',
      memoryRequest: typeof raw?.resources?.requests?.memory === 'string' ? raw.resources.requests.memory : '',
      cpuLimit: typeof raw?.resources?.limits?.cpu === 'string' ? raw.resources.limits.cpu : '',
      memoryLimit: typeof raw?.resources?.limits?.memory === 'string' ? raw.resources.limits.memory : '',
      preservedFields: Object.keys(preservedFields).length ? preservedFields : undefined,
      preservedEnv: preservedEnv.length ? preservedEnv : undefined,
    };
  });
}

export function serializeContainers(containers: readonly ContainerDraft[]): Record<string, unknown>[] {
  return containers.map((c) => {
    const out: Record<string, unknown> = {
      ...(c.preservedFields ?? {}),
      name: c.name.trim(),
      image: c.image.trim(),
    };
    if (c.imagePullPolicy) out.imagePullPolicy = c.imagePullPolicy;

    const command = splitCommandLine(c.command);
    if (command.length) out.command = command;

    const args = splitCommandLine(c.args);
    if (args.length) out.args = args;

    const validPorts = c.ports
      .map((p) => {
        const portNum = parseOptionalInt(p.containerPort);
        if (typeof portNum !== 'number' || portNum < 1 || portNum > 65535) return null;
        const portObj: Record<string, unknown> = { containerPort: portNum };
        if (p.name.trim()) portObj.name = p.name.trim();
        if (p.protocol !== 'TCP') portObj.protocol = p.protocol;
        return portObj;
      })
      .filter((p): p is Record<string, unknown> => p !== null);
    if (validPorts.length) out.ports = validPorts;

    const plainEnv = c.env
      .filter((e) => e.key.trim())
      .map((e) => ({ name: e.key.trim(), value: e.value }));
    const combinedEnv = [...plainEnv, ...(c.preservedEnv ?? [])];
    if (combinedEnv.length) out.env = combinedEnv;

    const requests: Record<string, string> = {};
    if (c.cpuRequest.trim()) requests.cpu = c.cpuRequest.trim();
    if (c.memoryRequest.trim()) requests.memory = c.memoryRequest.trim();
    const limits: Record<string, string> = {};
    if (c.cpuLimit.trim()) limits.cpu = c.cpuLimit.trim();
    if (c.memoryLimit.trim()) limits.memory = c.memoryLimit.trim();
    if (Object.keys(requests).length || Object.keys(limits).length) {
      out.resources = {
        ...(Object.keys(requests).length ? { requests } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
      };
    }
    return out;
  });
}

export function validateContainers(containers: readonly ContainerDraft[]): string {
  if (!containers.length) return 'Add at least one container.';
  const names = new Set<string>();
  for (let i = 0; i < containers.length; i += 1) {
    const c = containers[i];
    const label = c.name.trim() || `Container #${i + 1}`;
    if (!c.name.trim()) return `Container #${i + 1}: enter a container name.`;
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(c.name.trim())) {
      return `Container "${c.name.trim()}": name must be lowercase letters, digits, and hyphens.`;
    }
    if (names.has(c.name.trim())) return `Duplicate container name "${c.name.trim()}".`;
    names.add(c.name.trim());
    if (!c.image.trim()) return `${label}: enter a container image (for example, nginx:stable-alpine).`;
    for (const port of c.ports) {
      if (!port.containerPort.trim() && !port.name.trim()) continue;
      const parsed = parseOptionalInt(port.containerPort);
      if (typeof parsed !== 'number' || parsed < 1 || parsed > 65535) {
        return `${label}: container port must be an integer between 1 and 65535.`;
      }
    }
    const envError = validateKeyValueEntries(c.env, `${label} environment`);
    if (envError) return envError;
  }
  return '';
}

/* ============================ Pod ============================ */

export const POD_RESTART_POLICIES = ['Always', 'OnFailure', 'Never'] as const;
export type PodRestartPolicy = (typeof POD_RESTART_POLICIES)[number];

export interface PodCreatorState {
  restartPolicy: PodRestartPolicy;
  serviceAccountName: string;
  nodeName: string;
  containers: ContainerDraft[];
}

export const podCreatorModel: ResourceCreatorModel<PodCreatorState> = {
  group: '',
  kind: 'Pod',
  description: 'Run one or more containers directly in a single Pod.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const restartPolicy: PodRestartPolicy = POD_RESTART_POLICIES.includes(spec.restartPolicy) ? spec.restartPolicy : 'Always';
    return {
      restartPolicy,
      serviceAccountName: typeof spec.serviceAccountName === 'string' ? spec.serviceAccountName : '',
      nodeName: typeof spec.nodeName === 'string' ? spec.nodeName : '',
      containers: readContainers(spec.containers),
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      if (state.restartPolicy !== 'Always') setPath(doc, ['spec', 'restartPolicy'], state.restartPolicy);
      else deletePath(doc, ['spec', 'restartPolicy']);
      setOptionalString(doc, ['spec', 'serviceAccountName'], state.serviceAccountName);
      setOptionalString(doc, ['spec', 'nodeName'], state.nodeName);
      setPath(doc, ['spec', 'containers'], serializeContainers(state.containers));
    });
  },

  validate(state) {
    return validateContainers(state.containers);
  },
};

/* ============================ Deployment ============================ */

export const DEPLOYMENT_STRATEGIES = ['RollingUpdate', 'Recreate'] as const;
export type DeploymentStrategy = (typeof DEPLOYMENT_STRATEGIES)[number];

export interface DeploymentCreatorState {
  replicas: string;
  strategy: DeploymentStrategy;
  maxSurge: string;
  maxUnavailable: string;
  serviceAccountName: string;
  selectorLabels: KeyValueEntry[];
  containers: ContainerDraft[];
}

export const deploymentCreatorModel: ResourceCreatorModel<DeploymentCreatorState> = {
  group: 'apps',
  kind: 'Deployment',
  description: 'Manage replicated stateless Pods with declarative rolling updates.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const templateSpec = spec?.template?.spec ?? {};
    const strategy: DeploymentStrategy = spec?.strategy?.type === 'Recreate' ? 'Recreate' : 'RollingUpdate';
    const selector = readStringEntries(spec?.selector?.matchLabels ?? spec?.template?.metadata?.labels);
    return {
      replicas: spec.replicas !== undefined && spec.replicas !== null ? String(spec.replicas) : '1',
      strategy,
      maxSurge: spec?.strategy?.rollingUpdate?.maxSurge !== undefined ? String(spec.strategy.rollingUpdate.maxSurge) : '',
      maxUnavailable: spec?.strategy?.rollingUpdate?.maxUnavailable !== undefined ? String(spec.strategy.rollingUpdate.maxUnavailable) : '',
      serviceAccountName: typeof templateSpec.serviceAccountName === 'string' ? templateSpec.serviceAccountName : '',
      selectorLabels: selector.length ? selector : [{ id: 1, key: 'app', value: typeof object?.metadata?.name === 'string' ? object.metadata.name : 'my-deployment' }],
      containers: readContainers(templateSpec.containers),
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      const replicas = parseOptionalInt(state.replicas);
      if (typeof replicas === 'number' && replicas >= 0) {
        setPath(doc, ['spec', 'replicas'], replicas);
      }

      if (state.strategy === 'Recreate') {
        setPath(doc, ['spec', 'strategy'], { type: 'Recreate' });
      } else {
        const rolling: Record<string, string | number> = {};
        if (state.maxSurge.trim()) {
          const n = parseOptionalInt(state.maxSurge);
          rolling.maxSurge = typeof n === 'number' ? n : state.maxSurge.trim();
        }
        if (state.maxUnavailable.trim()) {
          const n = parseOptionalInt(state.maxUnavailable);
          rolling.maxUnavailable = typeof n === 'number' ? n : state.maxUnavailable.trim();
        }
        if (Object.keys(rolling).length) {
          setPath(doc, ['spec', 'strategy'], { type: 'RollingUpdate', rollingUpdate: rolling });
        } else {
          deletePath(doc, ['spec', 'strategy']);
        }
      }

      const selectorRecord = entriesToRecord(state.selectorLabels);
      if (Object.keys(selectorRecord).length) {
        setPath(doc, ['spec', 'selector', 'matchLabels'], selectorRecord);
        setPath(doc, ['spec', 'template', 'metadata', 'labels'], selectorRecord);
      }

      setOptionalString(doc, ['spec', 'template', 'spec', 'serviceAccountName'], state.serviceAccountName);
      setPath(doc, ['spec', 'template', 'spec', 'containers'], serializeContainers(state.containers));
    });
  },

  validate(state) {
    const replicas = parseOptionalInt(state.replicas);
    if (typeof replicas !== 'number' || replicas < 0) {
      return 'Replicas must be a non-negative integer.';
    }
    const selectorErr = validateKeyValueEntries(state.selectorLabels, 'Pod selector');
    if (selectorErr) return selectorErr;
    if (!Object.keys(entriesToRecord(state.selectorLabels)).length) {
      return 'Deployment requires at least one selector label (for example, app=web).';
    }
    return validateContainers(state.containers);
  },
};

/* ============================ Job ============================ */

export const JOB_RESTART_POLICIES = ['Never', 'OnFailure'] as const;
export type JobRestartPolicy = (typeof JOB_RESTART_POLICIES)[number];

export interface JobCreatorState {
  completions: string;
  parallelism: string;
  backoffLimit: string;
  ttlSecondsAfterFinished: string;
  restartPolicy: JobRestartPolicy;
  containers: ContainerDraft[];
}

export const jobCreatorModel: ResourceCreatorModel<JobCreatorState> = {
  group: 'batch',
  kind: 'Job',
  description: 'Run a finite batch task to completion.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const podSpec = spec?.template?.spec ?? {};
    return {
      completions: spec.completions !== undefined && spec.completions !== null ? String(spec.completions) : '',
      parallelism: spec.parallelism !== undefined && spec.parallelism !== null ? String(spec.parallelism) : '',
      backoffLimit: spec.backoffLimit !== undefined && spec.backoffLimit !== null ? String(spec.backoffLimit) : '',
      ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished !== undefined && spec.ttlSecondsAfterFinished !== null ? String(spec.ttlSecondsAfterFinished) : '',
      restartPolicy: podSpec.restartPolicy === 'OnFailure' ? 'OnFailure' : 'Never',
      containers: readContainers(podSpec.containers, 'task', 'busybox:stable'),
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      const setInt = (key: string, raw: string) => {
        const val = parseOptionalInt(raw);
        if (typeof val === 'number' && val >= 0) setPath(doc, ['spec', key], val);
        else if (val === undefined) deletePath(doc, ['spec', key]);
      };
      setInt('completions', state.completions);
      setInt('parallelism', state.parallelism);
      setInt('backoffLimit', state.backoffLimit);
      setInt('ttlSecondsAfterFinished', state.ttlSecondsAfterFinished);
      setPath(doc, ['spec', 'template', 'spec', 'restartPolicy'], state.restartPolicy);
      setPath(doc, ['spec', 'template', 'spec', 'containers'], serializeContainers(state.containers));
    });
  },

  validate(state) {
    for (const [label, raw, min] of [
      ['Completions', state.completions, 1],
      ['Parallelism', state.parallelism, 0],
      ['Backoff limit', state.backoffLimit, 0],
      ['TTL seconds after finished', state.ttlSecondsAfterFinished, 0],
    ] as const) {
      const parsed = parseOptionalInt(raw);
      if (parsed === null || (typeof parsed === 'number' && parsed < min)) {
        return `${label} must be an integer >= ${min}.`;
      }
    }
    return validateContainers(state.containers);
  },
};

/* ============================ CronJob ============================ */

export const CRONJOB_CONCURRENCY_POLICIES = ['Allow', 'Forbid', 'Replace'] as const;
export type CronJobConcurrencyPolicy = (typeof CRONJOB_CONCURRENCY_POLICIES)[number];

export interface CronJobCreatorState {
  schedule: string;
  concurrencyPolicy: CronJobConcurrencyPolicy;
  suspend: boolean;
  successfulJobsHistoryLimit: string;
  failedJobsHistoryLimit: string;
  restartPolicy: JobRestartPolicy;
  containers: ContainerDraft[];
}

export const cronJobCreatorModel: ResourceCreatorModel<CronJobCreatorState> = {
  group: 'batch',
  kind: 'CronJob',
  description: 'Schedule recurring Jobs using a standard cron expression.',
  defaultMetadataOpen: false,

  fromObject(object) {
    const spec = object?.spec ?? {};
    const podSpec = spec?.jobTemplate?.spec?.template?.spec ?? {};
    const concurrencyPolicy: CronJobConcurrencyPolicy = CRONJOB_CONCURRENCY_POLICIES.includes(spec.concurrencyPolicy)
      ? spec.concurrencyPolicy
      : 'Forbid';
    return {
      schedule: typeof spec.schedule === 'string' ? spec.schedule : '0 * * * *',
      concurrencyPolicy,
      suspend: spec.suspend === true,
      successfulJobsHistoryLimit: spec.successfulJobsHistoryLimit !== undefined && spec.successfulJobsHistoryLimit !== null ? String(spec.successfulJobsHistoryLimit) : '',
      failedJobsHistoryLimit: spec.failedJobsHistoryLimit !== undefined && spec.failedJobsHistoryLimit !== null ? String(spec.failedJobsHistoryLimit) : '',
      restartPolicy: podSpec.restartPolicy === 'OnFailure' ? 'OnFailure' : 'Never',
      containers: readContainers(podSpec.containers, 'task', 'busybox:stable'),
    };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      setPath(doc, ['spec', 'schedule'], state.schedule.trim());
      setPath(doc, ['spec', 'concurrencyPolicy'], state.concurrencyPolicy);
      if (state.suspend) setPath(doc, ['spec', 'suspend'], true);
      else deletePath(doc, ['spec', 'suspend']);

      const succ = parseOptionalInt(state.successfulJobsHistoryLimit);
      if (typeof succ === 'number' && succ >= 0) setPath(doc, ['spec', 'successfulJobsHistoryLimit'], succ);
      else if (succ === undefined) deletePath(doc, ['spec', 'successfulJobsHistoryLimit']);

      const fail = parseOptionalInt(state.failedJobsHistoryLimit);
      if (typeof fail === 'number' && fail >= 0) setPath(doc, ['spec', 'failedJobsHistoryLimit'], fail);
      else if (fail === undefined) deletePath(doc, ['spec', 'failedJobsHistoryLimit']);

      setPath(doc, ['spec', 'jobTemplate', 'spec', 'template', 'spec', 'restartPolicy'], state.restartPolicy);
      setPath(doc, ['spec', 'jobTemplate', 'spec', 'template', 'spec', 'containers'], serializeContainers(state.containers));
    });
  },

  validate(state) {
    const schedule = state.schedule.trim();
    if (!schedule) return 'CronJob requires a schedule expression (for example, 0 * * * *).';
    if (!schedule.startsWith('@') && schedule.split(/\s+/).length !== 5) {
      return 'Schedule must be a 5-field cron expression (minute hour day month weekday) or a macro like @hourly.';
    }
    for (const [label, raw] of [
      ['Successful jobs history limit', state.successfulJobsHistoryLimit],
      ['Failed jobs history limit', state.failedJobsHistoryLimit],
    ] as const) {
      const parsed = parseOptionalInt(raw);
      if (parsed === null || (typeof parsed === 'number' && parsed < 0)) {
        return `${label} must be a non-negative integer.`;
      }
    }
    return validateContainers(state.containers);
  },
};
