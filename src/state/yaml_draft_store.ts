import { create } from 'zustand';

export interface YamlDocumentMemento {
  draft: string;
  fullDraft: string;
  cleanView: boolean;
  resourceVersion: string;
  uid: string;
  dirty: boolean;
  updatedAt: number;
}

interface YamlDraftStore {
  drafts: Record<string, YamlDocumentMemento>;
  getDraft: (key: string) => YamlDocumentMemento | undefined;
  saveDraft: (key: string, memento: Omit<YamlDocumentMemento, 'updatedAt'>) => void;
  clearDraft: (key: string) => void;
  clearAll: () => void;
}

export function yamlDraftKey(context?: string | null, kind?: string, namespace?: string | null, name?: string, uid?: string): string {
  return `${context || 'default'}:${kind || '_'}:${namespace || '_'}:${name || '_'}:${uid || '_'}`;
}

export const useYamlDraftStore = create<YamlDraftStore>((set, get) => ({
  drafts: {},
  getDraft: (key: string) => get().drafts[key],
  saveDraft: (key: string, memento) => {
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: {
          ...memento,
          updatedAt: Date.now(),
        },
      },
    }));
  },
  clearDraft: (key: string) => {
    set((state) => {
      const next = { ...state.drafts };
      delete next[key];
      return { drafts: next };
    });
  },
  clearAll: () => set({ drafts: {} }),
}));
