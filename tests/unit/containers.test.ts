import { describe, expect, it } from 'vitest';
import { canExecContainer, containerTone, defaultContainer, podContainers } from '../../src/core/resources/containers';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useDockStore } from '../../src/state/dock_store';
import { useResourceStore } from '../../src/state/resource_store';
import { useClusterStore } from '../../src/state/cluster_store';

const raw = { metadata: { uid: 'original', name: 'web', namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'app' }, { name: 'proxy', image: 'proxy' }], initContainers: [{ name: 'setup', image: 'setup' }, { name: 'shipper', image: 'shipper', restartPolicy: 'Always' }], ephemeralContainers: [{ name: 'debug', image: 'debug' }] }, status: { containerStatuses: [{ name: 'proxy', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }, { name: 'app', ready: true, state: { running: {} } }], initContainerStatuses: [{ name: 'setup', state: { terminated: { exitCode: 0, reason: 'Completed' } } }, { name: 'shipper', ready: false, state: { running: {} } }], ephemeralContainerStatuses: [{ name: 'debug', state: { running: {} } }] } };
describe('Container identity, roles and status', () => {
  it('joins status by name and includes regular/init/native sidecar/ephemeral without relabelling legacy sidecars', () => {
    const containers = podContainers(mapK8sResource(raw, 'Pod'));
    expect(containers.map((c) => [c.name, c.role, c.state])).toEqual([['app','application','running'], ['proxy','application','waiting'], ['setup','init','terminated'], ['shipper','sidecar','running'], ['debug','ephemeral','running']]);
    expect(containers.map(containerTone)).toEqual(['ok','danger','info','warn','info']);
    expect(containers.map(canExecContainer)).toEqual([true,false,false,true,true]);
  });
  it('does not borrow another container status when status arrays are incomplete', () => {
    const containers = podContainers(mapK8sResource({ ...raw, status: { containerStatuses: [raw.status.containerStatuses[0]] } }, 'Pod'));
    expect(containers[0]).toMatchObject({ name: 'app', state: 'unknown', restarts: 0 });
  });
  it('respects default-container annotation and chooses a running init/sidecar when the application is waiting', () => {
    const item = mapK8sResource(raw, 'Pod'); expect(defaultContainer(item, true)).toBe('app');
    const annotated = mapK8sResource({ ...raw, metadata: { ...raw.metadata, annotations: { 'kubectl.kubernetes.io/default-container': 'shipper' } } }, 'Pod');
    expect(defaultContainer(annotated)).toBe('shipper');
    const initializing = mapK8sResource({ ...raw, status: { ...raw.status, containerStatuses: [{ name: 'app', state: { waiting: {} } }] } }, 'Pod');
    expect(defaultContainer(initializing, true)).toBe('shipper');
  });
  it('pins dock sessions to context and UID, switches in place and separates a recreated Pod', () => {
    useClusterStore.getState().selectContext('test'); useResourceStore.getState().reset(); useDockStore.getState().clearAllSessions();
    const item = mapK8sResource(raw, 'Pod'); useResourceStore.getState().setResourcesForKind('Pod', [item]);
    const first = useDockStore.getState().openTerminal('web', 'backend');
    expect(useDockStore.getState().sessions[0]).toMatchObject({ uid: 'original', context: 'test', container: 'app', allContainers: ['app','proxy','setup','shipper','debug'] });
    useDockStore.getState().updateSessionContainer(first, 'shipper');
    expect(useDockStore.getState().sessions).toHaveLength(1);
    expect(useDockStore.getState().openTerminal('web', 'backend', 'shipper')).toBe(first);
    useResourceStore.getState().setResourcesForKind('Pod', [{ ...item, uid: 'replacement' }]);
    expect(useDockStore.getState().openTerminal('web', 'backend', 'shipper')).not.toBe(first);
  });
});
