import React, { useMemo, useState } from 'react';
import { Bot, Check, Pencil, Pin, Plus, Search, Server, Settings, Trash2, X } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { getClusterTone } from '../../../core/cluster_color';
import { useAiStore } from '../store';
import { MODE_LABELS, PHASE_LABELS, type Conversation } from '../types';

function extractSnippet(text: string, term: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 15);
  const end = Math.min(text.length, idx + term.length + 35);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ') + suffix;
}

export const AiConversationsSidebar: React.FC = () => {
  const state = useAiStore();
  const [selectedClusterTag, setSelectedClusterTag] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');

  const clusterCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of state.conversations) {
      const key = c.scope.context || 'General';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [state.conversations]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = state.conversations;

    // Filter by cluster tag
    if (selectedClusterTag !== 'all') {
      list = list.filter(c => (c.scope.context || 'General') === selectedClusterTag);
    }

    // Filter by text search
    const results: Array<{ conv: Conversation; matchSnippet?: string }> = [];
    for (const c of list) {
      if (!q) {
        results.push({ conv: c });
        continue;
      }

      // Check title match
      if (c.title.toLowerCase().includes(q)) {
        results.push({ conv: c });
        continue;
      }

      // Check messages match
      let foundSnippet: string | undefined;
      for (const m of c.messages) {
        if (m.text && m.text.toLowerCase().includes(q)) {
          foundSnippet = extractSnippet(m.text, q);
          break;
        }
      }

      if (foundSnippet) {
        results.push({ conv: c, matchSnippet: foundSnippet });
      }
    }

    // Sort: pinned first, then by updatedAt descending
    results.sort((a, b) => {
      const aPinned = a.conv.pinned ? 1 : 0;
      const bPinned = b.conv.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aTime = a.conv.updatedAt ?? a.conv.createdAt ?? 0;
      const bTime = b.conv.updatedAt ?? b.conv.createdAt ?? 0;
      return bTime - aTime;
    });

    return results;
  }, [state.conversations, selectedClusterTag, searchQuery]);

  const handleStartRename = (c: Conversation) => {
    setEditingId(c.id);
    setEditTitle(c.title);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) {
      state.rename(id, editTitle.trim());
    }
    setEditingId(null);
  };

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

      <div className="ai-search-container">
        <Search size={12} className="ai-search-icon" aria-hidden="true" />
        <input
          type="text"
          className="ai-search-input"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search conversations"
        />
        {searchQuery && (
          <button
            type="button"
            className="ai-search-clear"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
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
        {Array.from(clusterCounts.entries()).map(([cluster, count]) => {
          const isGen = cluster === 'General';
          const isAll = cluster === 'All clusters';
          const tone = getClusterTone(isAll ? '*' : isGen ? '' : cluster);
          const isSpecial = isGen || isAll;
          return (
            <button
              key={cluster}
              type="button"
              role="tab"
              aria-selected={selectedClusterTag === cluster}
              className={`ai-cluster-tag ${selectedClusterTag === cluster ? 'is-active' : ''}`}
              onClick={() => setSelectedClusterTag(cluster)}
            >
              <span
                className="ai-cluster-status-dot-sm"
                style={{ backgroundColor: isSpecial ? 'var(--text-muted)' : tone.dot }}
                aria-hidden="true"
              />
              <span>{cluster}</span>
              <span className="ai-tag-count">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="ai-conversation-list kubiki-scrollbar">
        {searchResults.map(({ conv: c, matchSnippet }) => {
          const tone = getClusterTone(c.scope.context);
          const isSpecial = !c.scope.context || c.scope.context === 'general' || c.scope.context === '*';
          const isEditing = editingId === c.id;

          return (
            <div
              key={c.id}
              className={`ai-conversation-row ${c.id === state.activeId ? 'is-active' : ''}`}
            >
              <button
                type="button"
                aria-pressed={c.id === state.activeId}
                onClick={() => {
                  if (!isEditing) useAiStore.setState({ activeId: c.id });
                }}
              >
                {isEditing ? (
                  <div className="flex items-center gap-1 my-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      className="ai-rename-input"
                      value={editTitle}
                      autoFocus
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(c.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => handleSaveRename(c.id)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Confirm rename"
                      onClick={() => handleSaveRename(c.id)}
                    >
                      <Check size={11} className="text-emerald-400" aria-hidden="true" />
                    </Button>
                  </div>
                ) : (
                  <span
                    className="ai-conversation-title"
                    title={c.title}
                    onDoubleClick={() => handleStartRename(c)}
                  >
                    {c.pinned && (
                      <Pin size={10} className="ai-pinned-indicator inline-block mr-1 rotate-45" aria-hidden="true" />
                    )}
                    {c.title}
                  </span>
                )}

                {matchSnippet && (
                  <div className="ai-search-match" title={matchSnippet}>
                    "{matchSnippet}"
                  </div>
                )}

                <div className="ai-conversation-meta">
                  <span
                    className={`ai-cluster-badge ${!c.scope.context ? 'is-general' : ''}`}
                    style={!isSpecial ? {
                      color: tone.color,
                      backgroundColor: tone.bg,
                      borderColor: tone.border,
                    } : undefined}
                  >
                    <span
                      className="ai-cluster-status-dot-sm"
                      style={{ backgroundColor: isSpecial ? 'var(--text-muted)' : tone.dot }}
                      aria-hidden="true"
                    />
                    <Server size={10} style={!isSpecial ? { color: tone.color } : undefined} aria-hidden="true" />
                    <span>{c.scope.context || 'General'}</span>
                  </span>
                  <small>
                    {PHASE_LABELS[c.phase]} · {MODE_LABELS[c.mode]}
                  </small>
                </div>
              </button>

              <div className={`ai-conv-actions ${c.pinned ? 'is-pinned' : ''}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                  title={c.pinned ? 'Unpin' : 'Pin to top'}
                  onClick={(e) => {
                    e.stopPropagation();
                    state.togglePin(c.id);
                  }}
                >
                  <Pin
                    size={11}
                    className={c.pinned ? 'ai-pinned-indicator fill-current rotate-45' : 'text-[var(--text-muted)]'}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename conversation ${c.title}`}
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStartRename(c);
                  }}
                >
                  <Pencil size={11} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete conversation ${c.title}`}
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void state.remove(c.id);
                  }}
                >
                  <Trash2 size={11} aria-hidden="true" />
                </Button>
              </div>
            </div>
          );
        })}
        {searchResults.length === 0 && (
          <p className="ai-empty-history">
            {searchQuery
              ? `No conversations matching "${searchQuery}"`
              : state.conversations.length === 0
              ? 'No conversations yet'
              : 'No conversations in this cluster'}
          </p>
        )}
      </div>

      <p className="ai-help">
        Conversations are stored locally on this device in Read-only Plan mode.
      </p>
      <Button size="sm" onClick={() => state.setSettingsOpen(true)}>
        <Settings size={13} aria-hidden="true" />
        AI settings
      </Button>
    </aside>
  );
};
