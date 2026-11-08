import { useState } from 'react';
import { Brain, ChevronDown, Sparkles } from 'lucide-react';

export interface ParsedThinking {
  thinking?: string;
  isThinkingActive: boolean;
  content: string;
}

export function parseThinking(text: string, isStreaming: boolean): ParsedThinking {
  const thinkMatch = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i) ||
                     text.match(/<thought>([\s\S]*?)(?:<\/thought>|$)/i);
  if (!thinkMatch) {
    return { isThinkingActive: false, content: text };
  }

  const thinking = thinkMatch[1].trim();
  const hasClosed = /<\/think>|<\/thought>/i.test(text);
  const content = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .trim();

  return {
    thinking,
    isThinkingActive: !hasClosed && isStreaming,
    content,
  };
}

export function ThinkingBlock({ thinking, isActive }: { thinking: string; isActive: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`ai-thinking-block ${isActive ? 'is-active' : ''}`}>
      <div
        className="ai-thinking-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
      >
        <div className="flex items-center gap-2">
          {isActive ? (
            <Sparkles size={13} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
          ) : (
            <Brain size={13} className="text-indigo-400" aria-hidden="true" />
          )}
          <span className="font-medium">
            {isActive ? 'Thinking…' : 'Thought process'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span>{open ? 'Hide' : 'Show'}</span>
          <ChevronDown size={13} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </div>
      </div>
      {open && (
        <div className="ai-thinking-content kubiki-scrollbar">
          {thinking || 'Reasoning about prompt and cluster state…'}
        </div>
      )}
    </div>
  );
}
