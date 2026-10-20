import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ResourceKind } from '../types/k8s';
import { useResourceStore } from './resource_store';
import { defaultContainer, podContainers } from '../core/resources/containers';
import { useClusterStore } from './cluster_store';

export type DockSessionType = 'terminal' | 'logs' | 'ports' | 'events';
export type DockTargetType = 'local' | 'pod' | 'node';

export interface DockSession {
  id: string;
  context?: string | null;
  uid?: string;
  type: DockSessionType;
  title: string;
  subtitle?: string;
  targetType?: DockTargetType;
  kind?: ResourceKind;
  resourceName?: string;
  namespace?: string;
  container?: string;
  allContainers?: string[];
  pinned?: boolean;
}

interface DockState {
  sessions: DockSession[];
  activeSessionId: string;
  dockHeight: number;
  dockCollapsed: boolean;

  /* Actions */
  openLocalTerminal: () => string;
  openNodeShell: (nodeName: string) => string;
  openTerminal: (resourceName?: string, namespace?: string, container?: string, allContainers?: string[]) => string;
  openLogs: (resourceName: string, namespace?: string, container?: string, allContainers?: string[]) => string;
  openPorts: () => void;
  openEvents: () => void;
  closeSession: (id: string) => void;
  clearAllSessions: () => void;
  setActiveSession: (id: string) => void;
  toggleDock: () => void;
  setDockCollapsed: (collapsed: boolean) => void;
  setDockHeight: (h: number) => void;
  updateSessionContainer: (id: string, container: string) => void;
  focusTool: (type: DockSessionType) => void;
  resetLayout: () => void;
}

export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: '',
      dockHeight: 280,
      dockCollapsed: true,

      openLocalTerminal: () => {
        const { sessions } = get();
        const localCount = sessions.filter((s) => s.targetType === 'local').length;
        const num = localCount + 1;
        const id = `dock-term-local-${crypto.randomUUID()}`;

        const newSession: DockSession = {
          id,
          type: 'terminal',
          context: useClusterStore.getState().currentContext,
          title: `Terminal: Local Shell #${num}`,
          subtitle: 'Local host shell',
          targetType: 'local',
          resourceName: 'localhost',
          container: 'local',
          pinned: false,
        };

        set({
          sessions: [...sessions, newSession],
          activeSessionId: id,
          dockCollapsed: false,
        });

        return id;
      },

      openNodeShell: (nodeName: string) => {
        const { sessions } = get();
        const id = JSON.stringify(['node', useClusterStore.getState().currentContext, nodeName]);
        const existing = sessions.find((s) => s.id === id);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'terminal',
          context: useClusterStore.getState().currentContext,
          title: `Node Shell: ${nodeName}`,
          subtitle: 'Cluster Node',
          targetType: 'node',
          resourceName: nodeName,
          container: 'sh',
          pinned: false,
        };

        set({
          sessions: [...sessions, newSession],
          activeSessionId: id,
          dockCollapsed: false,
        });

        return id;
      },

      openTerminal: (resourceName, namespace = 'default', container, allContainers = []) => {
        if (!resourceName || resourceName === 'host' || resourceName === 'local' || resourceName === 'localhost') {
          return get().openLocalTerminal();
        }
        if (resourceName.startsWith('node/')) {
          return get().openNodeShell(resourceName.replace('node/', ''));
        }

        const { sessions } = get();
        const context = useClusterStore.getState().currentContext;
        const pod = [...useResourceStore.getState().resources.Pod.values()].find((item) => item.name === resourceName && item.namespace === namespace);
        container ??= defaultContainer(pod, true) ?? allContainers[0] ?? '';
        if (pod) allContainers = podContainers(pod).map((c) => c.name);
        const id = `dock-terminal-${crypto.randomUUID()}`;
        const existing = sessions.find((s) => s.type === 'terminal' && s.context === context && s.uid === pod?.uid && s.resourceName === resourceName && s.namespace === namespace && s.container === container);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'terminal',
          context, uid: pod?.uid,
          title: `Pod: ${resourceName}`,
          subtitle: `${namespace} · ${container}`,
          targetType: 'pod',
          kind: 'Pod',
          resourceName,
          namespace,
          container,
          allContainers: allContainers.length > 0 ? allContainers : [container],
          pinned: false,
        };

        set({
          sessions: [...sessions, newSession],
          activeSessionId: id,
          dockCollapsed: false,
        });

        return id;
      },

      openLogs: (resourceName, namespace = 'default', container, allContainers = []) => {
        const { sessions } = get();
        const context = useClusterStore.getState().currentContext;
        const pod = [...useResourceStore.getState().resources.Pod.values()].find((item) => item.name === resourceName && item.namespace === namespace);
        container ??= defaultContainer(pod, false) ?? allContainers[0] ?? '';
        if (pod) allContainers = podContainers(pod).map((c) => c.name);
        const id = `dock-logs-${crypto.randomUUID()}`;
        const existing = sessions.find((s) => s.type === 'logs' && s.context === context && s.uid === pod?.uid && s.resourceName === resourceName && s.namespace === namespace && s.container === container);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'logs',
          context, uid: pod?.uid,
          title: `Logs: ${resourceName}`,
          subtitle: `${namespace} · ${container}`,
          targetType: 'pod',
          kind: 'Pod',
          resourceName,
          namespace,
          container,
          allContainers: allContainers.length > 0 ? allContainers : [container],
          pinned: false,
        };

        set({
          sessions: [...sessions, newSession],
          activeSessionId: id,
          dockCollapsed: false,
        });

        return id;
      },

      openPorts: () => {
        const { sessions } = get();
        let portSession = sessions.find((s) => s.type === 'ports');
        if (!portSession) {
          portSession = {
            id: 'dock-ports',
            type: 'ports',
            title: 'Port Forwarding',
            subtitle: 'active tunnels',
            pinned: false,
          };
          set({ sessions: [...sessions, portSession], activeSessionId: portSession.id, dockCollapsed: false });
        } else {
          set({ activeSessionId: portSession.id, dockCollapsed: false });
        }
      },

      openEvents: () => {
        const { sessions } = get();
        let eventSession = sessions.find((s) => s.type === 'events');
        if (!eventSession) {
          eventSession = {
            id: 'dock-events',
            type: 'events',
            title: 'Cluster Events',
            subtitle: 'all namespaces',
            pinned: false,
          };
          set({ sessions: [...sessions, eventSession], activeSessionId: eventSession.id, dockCollapsed: false });
        } else {
          set({ activeSessionId: eventSession.id, dockCollapsed: false });
        }
      },

      closeSession: (id) => {
        const { sessions, activeSessionId } = get();
        const next = sessions.filter((s) => s.id !== id);
        if (next.length === 0) {
          set({ sessions: [], activeSessionId: '', dockCollapsed: true });
          return;
        }

        let nextActive = activeSessionId;
        if (activeSessionId === id) {
          const idx = sessions.findIndex((s) => s.id === id);
          const candidate = next[Math.max(0, idx - 1)] || next[0];
          nextActive = candidate ? candidate.id : '';
        }

        set({ sessions: next, activeSessionId: nextActive });
      },

      clearAllSessions: () => {
        set({ sessions: [], activeSessionId: '', dockCollapsed: true });
      },

      setActiveSession: (id) => set({ activeSessionId: id, dockCollapsed: false }),

      toggleDock: () => set((s) => ({ dockCollapsed: !s.dockCollapsed })),

      setDockCollapsed: (dockCollapsed) => set({ dockCollapsed }),

      setDockHeight: (h) => set({ dockHeight: Math.min(600, Math.max(140, h)), dockCollapsed: false }),

      resetLayout: () => set({ dockHeight: 280, dockCollapsed: true }),
      focusTool: (type) => {
        const session = get().sessions.find((s) => s.type === type);
        if (session) get().setActiveSession(session.id);
        else if (type === 'ports') get().openPorts();
        else if (type === 'events') get().openEvents();
        else set({ dockCollapsed: false });
      },

      updateSessionContainer: (id, container) => {
        const session = get().sessions.find((entry) => entry.id === id);
        if (!session?.resourceName || session.targetType !== 'pod') return;
        set((state) => ({ sessions: state.sessions.map((entry) => entry.id === id ? { ...entry, container, subtitle: `${entry.namespace} · ${container}` } : entry) }));
      },
    }),
    {
      name: 'kubiki.dock.v3',
      partialize: (s) => ({
        dockHeight: s.dockHeight,
        dockCollapsed: s.dockCollapsed,
      }),
    }
  )
);
