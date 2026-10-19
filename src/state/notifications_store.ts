import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  description?: string;
}

interface NotificationsState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let seq = 1;

export const useNotifications = create<NotificationsState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-5) }));
    if (t.type !== 'error') {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4200);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = {
  success: (title: string, description?: string) => useNotifications.getState().push({ type: 'success', title, description }),
  info: (title: string, description?: string) => useNotifications.getState().push({ type: 'info', title, description }),
  warn: (title: string, description?: string) => useNotifications.getState().push({ type: 'warn', title, description }),
  error: (title: string, description?: string) => useNotifications.getState().push({ type: 'error', title, description }),
};
