import { useEffect, useState } from 'react';
import { TitleBar } from './components/layout/TitleBar';
import { ActivityBar, Perspective } from './components/layout/ActivityBar';
import { Sidebar } from './components/layout/Sidebar';
import { ResourceTable } from './components/k8s/ResourceTable';
import { InspectorDrawer } from './components/layout/InspectorDrawer';
import { BottomDock, DockTab } from './components/layout/BottomDock';
import { useClusterStore } from './state/cluster_store';
import { useResourceStore } from './state/resource_store';
import { ResourceItem } from './types/k8s';

export function App() {
  const [perspective, setPerspective] = useState<Perspective>('workloads');
  const [dockTab, setDockTab] = useState<DockTab>('terminal');
  const [isDockOpen, setIsDockOpen] = useState(false);
  const [activePodForLogs, setActivePodForLogs] = useState<string | undefined>();
  const [activePodForTerminal, setActivePodForTerminal] = useState<string | undefined>();

  const { setContexts, setConnected } = useClusterStore();
  const { setResourcesForKind, activeKind } = useResourceStore();

  useEffect(() => {
    // Initial mock contexts
    setContexts([
      {
        name: 'minikube',
        cluster: 'minikube',
        user: 'minikube',
        namespace: 'default',
        is_current: true,
      },
      {
        name: 'staging-us-east',
        cluster: 'k8s-staging',
        user: 'developer',
        namespace: 'backend',
        is_current: false,
      },
      {
        name: 'prod-europe-west',
        cluster: 'k8s-prod',
        user: 'admin',
        namespace: 'production',
        is_current: false,
      },
    ]);
    setConnected(true, 'v1.32.1');

    // Populate initial sample Kubernetes resources
    const mockPods: ResourceItem[] = [
      {
        uid: 'pod-101',
        name: 'api-gateway-7b9f8d5-q7x9z',
        namespace: 'default',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '14m',
        ip: '10.244.0.15',
        node: 'minikube-worker-01',
      },
      {
        uid: 'pod-102',
        name: 'auth-service-58848db6cb-kl8m2',
        namespace: 'default',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '2/2',
        restarts: 1,
        age: '1h',
        ip: '10.244.0.18',
        node: 'minikube-worker-02',
      },
      {
        uid: 'pod-103',
        name: 'payment-worker-67f98b984-pv4n8',
        namespace: 'default',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'CrashLoopBackOff',
        ready: '0/1',
        restarts: 8,
        age: '24m',
        ip: '10.244.0.21',
        node: 'minikube-worker-01',
      },
      {
        uid: 'pod-104',
        name: 'redis-cache-0',
        namespace: 'default',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '4d',
        ip: '10.244.0.24',
        node: 'minikube-master',
      },
      {
        uid: 'pod-105',
        name: 'postgres-db-0',
        namespace: 'default',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '4d',
        ip: '10.244.0.25',
        node: 'minikube-master',
      },
      {
        uid: 'pod-106',
        name: 'ingress-nginx-controller-7798b6885-8h9f4',
        namespace: 'kube-system',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '12d',
        ip: '10.244.0.4',
        node: 'minikube-master',
      },
      {
        uid: 'pod-107',
        name: 'coredns-668d6bf9bc-j92k7',
        namespace: 'kube-system',
        kind: 'Pod',
        apiVersion: 'v1',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '12d',
        ip: '10.244.0.2',
        node: 'minikube-master',
      },
    ];

    const mockDeployments: ResourceItem[] = [
      {
        uid: 'dep-201',
        name: 'api-gateway',
        namespace: 'default',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        status: 'Active',
        ready: '1/1',
        restarts: 0,
        age: '14m',
      },
      {
        uid: 'dep-202',
        name: 'auth-service',
        namespace: 'default',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        status: 'Active',
        ready: '2/2',
        restarts: 1,
        age: '1h',
      },
      {
        uid: 'dep-203',
        name: 'payment-worker',
        namespace: 'default',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        status: 'Pending',
        ready: '0/1',
        restarts: 8,
        age: '24m',
      },
    ];

    const mockServices: ResourceItem[] = [
      {
        uid: 'svc-301',
        name: 'kubernetes',
        namespace: 'default',
        kind: 'Service',
        apiVersion: 'v1',
        status: 'Active',
        ready: '443/TCP',
        age: '12d',
      },
      {
        uid: 'svc-302',
        name: 'api-gateway',
        namespace: 'default',
        kind: 'Service',
        apiVersion: 'v1',
        status: 'Active',
        ready: '80:30080/TCP',
        age: '14m',
      },
      {
        uid: 'svc-303',
        name: 'redis-cache',
        namespace: 'default',
        kind: 'Service',
        apiVersion: 'v1',
        status: 'Active',
        ready: '6379/TCP',
        age: '4d',
      },
    ];

    const mockConfigMaps: ResourceItem[] = [
      {
        uid: 'cm-401',
        name: 'api-gateway-config',
        namespace: 'default',
        kind: 'ConfigMap',
        apiVersion: 'v1',
        status: 'Active',
        age: '14m',
      },
      {
        uid: 'cm-402',
        name: 'kube-root-ca.crt',
        namespace: 'default',
        kind: 'ConfigMap',
        apiVersion: 'v1',
        status: 'Active',
        age: '12d',
      },
    ];

    const mockSecrets: ResourceItem[] = [
      {
        uid: 'sec-501',
        name: 'database-credentials',
        namespace: 'default',
        kind: 'Secret',
        apiVersion: 'v1',
        status: 'Active',
        age: '4d',
      },
      {
        uid: 'sec-502',
        name: 'jwt-signing-key',
        namespace: 'default',
        kind: 'Secret',
        apiVersion: 'v1',
        status: 'Active',
        age: '1h',
      },
    ];

    setResourcesForKind('Pod', mockPods);
    setResourcesForKind('Deployment', mockDeployments);
    setResourcesForKind('Service', mockServices);
    setResourcesForKind('ConfigMap', mockConfigMaps);
    setResourcesForKind('Secret', mockSecrets);
  }, [setContexts, setConnected, setResourcesForKind]);

  const handleOpenShell = (item: ResourceItem) => {
    setActivePodForTerminal(item.name);
    setDockTab('terminal');
    setIsDockOpen(true);
  };

  const handleOpenLogs = (item: ResourceItem) => {
    setActivePodForLogs(item.name);
    setDockTab('logs');
    setIsDockOpen(true);
  };

  const handleOpenPortForward = (item: ResourceItem) => {
    setActivePodForTerminal(item.name);
    setDockTab('ports');
    setIsDockOpen(true);
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Top Title Bar */}
      <TitleBar />

      {/* Main Middle Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Leftmost Activity Bar */}
        <ActivityBar
          activePerspective={perspective}
          onSelectPerspective={setPerspective}
        />

        {/* Tree Sidebar */}
        <Sidebar />

        {/* Center Main Stage */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg-primary)]">
          {/* View Toolbar Header */}
          <div className="h-9 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between px-4 text-xs select-none">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--text-primary)]">{activeKind}s</span>
              <span className="text-[11px] text-[var(--text-muted)]">
                (Click any row to open the Inspector drawer)
              </span>
            </div>
          </div>

          {/* Table */}
          <ResourceTable
            onOpenShell={handleOpenShell}
            onOpenLogs={handleOpenLogs}
            onOpenPortForward={handleOpenPortForward}
          />
        </div>

        {/* Right Inspector Drawer */}
        <InspectorDrawer />
      </div>

      {/* Bottom Dock */}
      <BottomDock
        activeTab={dockTab}
        onSelectTab={setDockTab}
        isOpen={isDockOpen}
        onToggleOpen={() => setIsDockOpen(!isDockOpen)}
        podNameForLogs={activePodForLogs}
        podNameForTerminal={activePodForTerminal}
      />
    </div>
  );
}

export default App;
