import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ResourceKind } from '../types/k8s';

export type DockSessionType = 'terminal' | 'logs' | 'ports' | 'events';

export interface DockSession {
  id: string;
  type: DockSessionType;
  title: string;
  subtitle?: string;
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
  openTerminal: (resourceName?: string, namespace?: string, container?: string, allContainers?: string[]) => string;
  openLogs: (resourceName: string, namespace?: string, container?: string, allContainers?: string[]) => string;
  openPorts: () => void;
  openEvents: () => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  toggleDock: () => void;
  setDockCollapsed: (collapsed: boolean) => void;
  setDockHeight: (h: number) => void;
  updateSessionContainer: (id: string, container: string) => void;
}

const DEFAULT_SESSIONS: DockSession[] = [
  {
    id: 'dock-terminal-default',
    type: 'terminal',
    title: 'Terminal: Node Shell',
    subtitle: 'minikube (default)',
    resourceName: 'node/minikube',
    namespace: 'default',
    container: 'sh',
    pinned: true,
  },
  {
    id: 'dock-ports',
    type: 'ports',
    title: 'Port Forwarding',
    subtitle: 'active tunnels',
  },
  {
    id: 'dock-events',
    type: 'events',
    title: 'Cluster Events',
    subtitle: 'all namespaces',
  },
];

export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      sessions: DEFAULT_SESSIONS,
      activeSessionId: 'dock-terminal-default',
      dockHeight: 280,
      dockCollapsed: true,

      openTerminal: (resourceName, namespace = 'default', container = 'app', allContainers = []) => {
        const { sessions } = get();
        const isHost = !resourceName || resourceName === 'host' || resourceName.startsWith('node/');
        const id = isHost ? 'dock-terminal-default' : `dock-term-${resourceName}-${container}`;

        const existing = sessions.find((s) => s.id === id);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'terminal',
          title: isHost ? 'Terminal: Node Shell' : `Terminal: ${resourceName}`,
          subtitle: `${namespace} · ${container}`,
          kind: 'Pod',
          resourceName: resourceName || 'minikube',
          namespace,
          container,
          allContainers: allContainers.length > 0 ? allContainers : [container, 'istio-proxy'],
        };

        set({
          sessions: [...sessions, newSession],
          activeSessionId: id,
          dockCollapsed: false,
        });

        return id;
      },

      openLogs: (resourceName, namespace = 'default', container = 'app', allContainers = []) => {
        const { sessions } = get();
        const id = `dock-logs-${resourceName}-${container}`;

        const existing = sessions.find((s) => s.id === id);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'logs',
          title: `Logs: ${resourceName}`,
          subtitle: `${namespace} · ${container}`,
          kind: 'Pod',
          resourceName,
          namespace,
          container,
          allContainers: allContainers.length > 0 ? allContainers : [container],
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
          };
          set({ sessions: [...sessions, eventSession], activeSessionId: eventSession.id, dockCollapsed: false });
        } else {
          set({ activeSessionId: eventSession.id, dockCollapsed: false });
        }
      },

      closeSession: (id) => {
        const { sessions, activeSessionId } = get();
        const target = sessions.find((s) => s.id === id);
        if (target?.pinned) return;

        const next = sessions.filter((s) => s.id !== id);
        if (next.length === 0) {
          set({ sessions: DEFAULT_SESSIONS, activeSessionId: DEFAULT_SESSIONS[0].id });
          return;
        }

        let nextActive = activeSessionId;
        if (activeSessionId === id) {
          const idx = sessions.findIndex((s) => s.id === id);
          const candidate = next[Math.max(0, idx - 1)] || next[0];
          nextActive = candidate.id;
        }

        set({ sessions: next, activeSessionId: nextActive });
      },

      setActiveSession: (id) => set({ activeSessionId: id, dockCollapsed: false }),

      toggleDock: () => set((s) => ({ dockCollapsed: !s.dockCollapsed })),

      setDockCollapsed: (dockCollapsed) => set({ dockCollapsed }),

      setDockHeight: (h) => set({ dockHeight: Math.min(600, Math.max(140, h)), dockCollapsed: false }),

      updateSessionContainer: (id, container) => {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, container, subtitle: `${s.namespace} · ${container}` } : s)),
        }));
      },
    }),
    {
      name: 'kubiki.dock.v1',
      partialize: (s) => ({
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
        dockHeight: s.dockHeight,
        dockCollapsed: s.dockCollapsed,
      }),
    }
  )
);
