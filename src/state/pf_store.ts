import { create } from 'zustand';

export interface PfSession {
  id: string;
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
  remove: (id: string) => void;
  tick: () => void;
  clear: () => void;
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
  remove: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
  tick: () =>
    set((s) => ({
      sessions: s.sessions.map((x) => ({
        ...x,
        bytesIn: x.bytesIn + Math.floor(Math.random() * 2400),
        bytesOut: x.bytesOut + Math.floor(Math.random() * 900),
      })),
    })),
  clear: () => set({ sessions: [] }),
}));
