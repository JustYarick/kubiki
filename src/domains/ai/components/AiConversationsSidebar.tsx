import React, { useMemo, useState } from 'react';
import { Bot, Plus, Server, Settings, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { useAiStore } from '../store';
import { MODE_LABELS, PHASE_LABELS } from '../types';

export const AiConversationsSidebar: React.FC = () => {
  const state = useAiStore();
  const [selectedClusterTag, setSelectedClusterTag] = useState<string>('all');

  const clusterCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of state.conversations) {
      const key = c.scope.context || 'General';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [state.conversations]);

  const filtered = useMemo(() => {
    if (selectedClusterTag === 'all') return state.conversations;
    return state.conversations.filter(c => (c.scope.context || 'General') === selectedClusterTag);
  }, [state.conversations, selectedClusterTag]);

  return (
    <aside className="ai-conversations h-full w-full" aria-label="AI conversations">
      <div className="ai-form-line">
        <strong>
          <Bot size={15} aria-hidden="true" />
          AI Agent
        </strong>
        <span className="ai-grow" />
        <Button
          size="sm"
          aria-label="New AI conversation"
          onClick={() => useAiStore.setState({ activeId: null })}
        >
          <Plus size={13} aria-hidden="true" />
        </Button>
      </div>

      <div className="ai-cluster-tags kubiki-scrollbar" role="tablist" aria-label="Filter conversations by cluster">
        <button
          type="button"
          role="tab"
          aria-selected={selectedClusterTag === 'all'}
          className={`ai-cluster-tag ${selectedClusterTag === 'all' ? 'is-active' : ''}`}
          onClick={() => setSelectedClusterTag('all')}
        >
          All <span className="ai-tag-count">({state.conversations.length})</span>
        </button>
        {Array.from(clusterCounts.entries()).map(([cluster, count]) => (
          <button
            key={cluster}
            type="button"
            role="tab"
            aria-selected={selectedClusterTag === cluster}
            className={`ai-cluster-tag ${selectedClusterTag === cluster ? 'is-active' : ''}`}
            onClick={() => setSelectedClusterTag(cluster)}
          >
            <Server size={10} aria-hidden="true" />
            <span>{cluster}</span>
            <span className="ai-tag-count">({count})</span>
          </button>
        ))}
      </div>

      <div className="ai-conversation-list kubiki-scrollbar">
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`ai-conversation-row ${c.id === state.activeId ? 'is-active' : ''}`}
          >
            <button
              type="button"
              aria-pressed={c.id === state.activeId}
              onClick={() => useAiStore.setState({ activeId: c.id })}
            >
              <span className="ai-conversation-title">{c.title}</span>
              <div className="ai-conversation-meta">
                <span className={`ai-cluster-badge ${!c.scope.context ? 'is-general' : ''}`}>
                  <Server size={10} aria-hidden="true" />
                  {c.scope.context || 'General'}
                </span>
                <small>
                  {PHASE_LABELS[c.phase]} · {MODE_LABELS[c.mode]}
                </small>
              </div>
            </button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete conversation ${c.title}`}
              onClick={() => void state.remove(c.id)}
            >
              <Trash2 size={12} aria-hidden="true" />
            </Button>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="ai-empty-history">
            {state.conversations.length === 0 ? 'No conversations yet' : 'No conversations in this cluster'}
          </p>
        )}
      </div>

      <p className="ai-help">
        Conversations stay in memory. Permissions and provider connections are saved on this device.
      </p>
      <Button size="sm" onClick={() => state.setSettingsOpen(true)}>
        <Settings size={13} aria-hidden="true" />
        AI settings
      </Button>
    </aside>
  );
};
