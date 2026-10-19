import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ResourceKind } from '../types/k8s';

export type DockSessionType = 'terminal' | 'logs' | 'ports' | 'events';
export type DockTargetType = 'local' | 'pod' | 'node';

export interface DockSession {
  id: string;
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
}

const DEFAULT_SESSIONS: DockSession[] = [
  {
    id: 'dock-local-terminal-1',
    type: 'terminal',
    title: 'Terminal: Local Shell',
    subtitle: 'localhost (bash/zsh)',
    targetType: 'local',
    resourceName: 'localhost',
    pinned: false,
  },
  {
    id: 'dock-ports',
    type: 'ports',
    title: 'Port Forwarding',
    subtitle: 'active tunnels',
    pinned: false,
  },
  {
    id: 'dock-events',
    type: 'events',
    title: 'Cluster Events',
    subtitle: 'all namespaces',
    pinned: false,
  },
];

export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      sessions: DEFAULT_SESSIONS,
      activeSessionId: 'dock-local-terminal-1',
      dockHeight: 280,
      dockCollapsed: true,

      openLocalTerminal: () => {
        const { sessions } = get();
        const localCount = sessions.filter((s) => s.targetType === 'local').length;
        const num = localCount + 1;
        const id = `dock-term-local-${Date.now()}`;

        const newSession: DockSession = {
          id,
          type: 'terminal',
          title: `Terminal: Local Shell #${num}`,
          subtitle: 'localhost (bash/zsh)',
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
        const id = `dock-node-${nodeName}`;
        const existing = sessions.find((s) => s.id === id);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'terminal',
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

      openTerminal: (resourceName, namespace = 'default', container = 'app', allContainers = []) => {
        if (!resourceName || resourceName === 'host' || resourceName === 'local' || resourceName === 'localhost') {
          return get().openLocalTerminal();
        }
        if (resourceName.startsWith('node/')) {
          return get().openNodeShell(resourceName.replace('node/', ''));
        }

        const { sessions } = get();
        const id = `dock-term-${resourceName}-${container}`;

        const existing = sessions.find((s) => s.id === id);
        if (existing) {
          set({ activeSessionId: existing.id, dockCollapsed: false });
          return existing.id;
        }

        const newSession: DockSession = {
          id,
          type: 'terminal',
          title: `Pod: ${resourceName}`,
          subtitle: `${namespace} · ${container}`,
          targetType: 'pod',
          kind: 'Pod',
          resourceName,
          namespace,
          container,
          allContainers: allContainers.length > 0 ? allContainers : [container, 'istio-proxy'],
          pinned: false,
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

      updateSessionContainer: (id, container) => {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, container, subtitle: `${s.namespace} · ${container}` } : s)),
        }));
      },
    }),
    {
      name: 'kubiki.dock.v2',
      partialize: (s) => ({
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
        dockHeight: s.dockHeight,
        dockCollapsed: s.dockCollapsed,
      }),
    }
  )
);
