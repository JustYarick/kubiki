import type { ForwardSession } from '../providers/port_forward';
import { create } from 'zustand';

export interface PfSession {
  id: string;
  live?: boolean;
  context?: string;
  podName?: string;
  podPort?: number;
  phase?: string;
  error?: string;
  targetKind: string;
  targetName: string;
  namespace: string;
  remotePort: number;
  localPort: number;
  openBrowser: boolean;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
}

interface PfState {
  sessions: PfSession[];
  add: (s: Omit<PfSession, 'id' | 'startedAt' | 'bytesIn' | 'bytesOut'>) => PfSession;
  upsertLive: (session: ForwardSession) => PfSession;
  syncLive: (sessions: ForwardSession[], context: string, requestedIds: string[]) => void;
  remove: (id: string) => void;
  tick: () => void;
  clear: () => void;
}

export function mapForwardSession(session: ForwardSession): PfSession {
  return { id: session.id, live: true, context: session.resource.context, targetKind: session.target_kind, targetName: session.name,
    namespace: session.namespace, remotePort: session.remote_port, localPort: session.local_port, openBrowser: false,
    podName: session.pod_name, podPort: session.pod_port, phase: typeof session.status === 'string' ? session.status : 'Failed',
    error: session.last_error?.message ?? (typeof session.status === 'object' ? session.status.Failed : undefined),
    startedAt: session.started_at, bytesOut: session.bytes_sent, bytesIn: session.bytes_received };
}
const randomLocal = () => 30000 + Math.floor(Math.random() * 20000);

export const usePfStore = create<PfState>((set) => ({
  sessions: [],
  add: (partial) => {
    const session: PfSession = {
      ...partial,
      id: `pf-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      localPort: partial.localPort === 0 ? randomLocal() : partial.localPort,
    };
    set((s) => ({ sessions: [...s.sessions, session] }));
    return session;
  },
  upsertLive: (native) => { const session = mapForwardSession(native); set(state => ({ sessions: [...state.sessions.filter(existing => existing.id !== session.id), session] })); return session; },
  syncLive: (sessions, context, requestedIds) => set(state => {
    const requested = new Set(requestedIds);
    const current = new Set(state.sessions.filter(session => session.live).map(session => session.id));
    return { sessions: [...state.sessions.filter(session => !session.live || !requested.has(session.id)), ...sessions.filter(session => session.resource.context === context && requested.has(session.id) && current.has(session.id)).map(mapForwardSession)] };
  }),
  remove: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
  tick: () =>
    set((s) => ({
      sessions: s.sessions.map((x) => x.live ? x : ({
        ...x,
        bytesIn: x.bytesIn + Math.floor(Math.random() * 2400),
        bytesOut: x.bytesOut + Math.floor(Math.random() * 900),
      })),
    })),
  clear: () => set({ sessions: [] }),
}));
