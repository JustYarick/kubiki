import React, { useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { getToolCallSummary, getToolIntent } from '../tool_intents';
import type { ChatMessage, Conversation } from '../types';

export function CompactToolMessage({
  message: m,
  conversation: c,
}: {
  message: ChatMessage;
  conversation: Conversation;
}) {
  const result = m.result;
  const error = typeof result?.error === 'string' ? result.error : result?.isError === true ? 'MCP tool reported an error' : ['failed', 'cancelled', 'uncertain'].includes(String(result?.status)) ? `Change ${result?.status}; inspect the recorded outcome` : undefined;
  const isRunning = !result && c.busy;
  const args = (m.call?.arguments || {}) as Record<string, any>;
  const targetSummary = args ? [args.namespace, args.kind, args.name].filter(Boolean).join('/') : '';
  const intent = getToolIntent(m.call?.name ?? '', args);
  const summary = getToolCallSummary(m.call?.name ?? '', args, result);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const rawJson = result ? JSON.stringify(result, null, 2) : JSON.stringify(m.call?.arguments ?? {}, null, 2);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(rawJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <article
      className={`ai-tool-compact ${error ? 'has-error' : ''} ${isRunning ? 'is-running' : ''}`}
      aria-label={`AI tool ${m.call?.name}`}
    >
      <div
        className="ai-tool-compact-bar"
        onClick={() => !isRunning && setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!isRunning) setExpanded(!expanded);
          }
        }}
      >
        <div className="ai-tool-compact-left">
          {isRunning ? (
            <RefreshCw size={12} className="ai-thinking-spinner text-amber-400 shrink-0" aria-hidden="true" />
          ) : error ? (
            <AlertCircle size={12} className="text-[var(--status-danger)] shrink-0" aria-hidden="true" />
          ) : (
            <Check size={12} className="text-emerald-400 shrink-0" aria-hidden="true" />
          )}

          <span className="ai-tooling-badge">TOOL</span>
          <span className={`ai-tool-intent-badge is-${intent.color}`}>{intent.badge}</span>
          <span className="font-mono font-semibold text-[var(--text-primary)] text-xs">{m.call?.name}</span>

          {targetSummary && (
            <span className="ai-tool-badge font-mono truncate max-w-[180px]" title={targetSummary}>
              {targetSummary}
            </span>
          )}

          <span className="ai-tool-compact-arrow" aria-hidden="true">→</span>
          <span className={`ai-tool-compact-summary truncate ${error ? 'text-[var(--status-danger)]' : 'text-[var(--text-secondary)]'}`}>
            {summary}
          </span>
        </div>

        <div className="ai-tool-compact-right">
          {m.durationMs ? (
            <span className="text-[var(--text-muted)] font-mono text-[10.5px]">
              {(m.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}

          {!isRunning && (
            <span className="ai-tool-expand-btn" title={expanded ? 'Hide raw output' : 'Show raw output'}>
              {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="ai-tool-expanded-drawer">
          <div className="ai-tool-drawer-header">
            <div className="text-[11px] text-[var(--text-secondary)] flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[var(--text-primary)]">{intent.title}</span>
              {intent.description && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  · {intent.description}
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              className="h-6 px-2 text-[10.5px] shrink-0"
            >
              {copied ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <Check size={11} aria-hidden="true" /> Copied
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Copy size={11} aria-hidden="true" /> Copy Output
                </span>
              )}
            </Button>
          </div>
          {result?.yaml ? (
            <div>
              <pre className="ai-tool-result kubiki-scrollbar" aria-label="YAML content">{String(result.yaml)}</pre>
            </div>
          ) : m.call?.name === 'run_command' && result && !result.payloadOmitted ? <div>
            <pre className="ai-tool-result kubiki-scrollbar" aria-label="Command output">{String(result.stdout ?? '')}{result.stderr ? `\n${result.stderr}` : ''}</pre>
            <details><summary>Raw result</summary><pre className="ai-tool-result kubiki-scrollbar">{rawJson}</pre></details>
          </div> : <pre className="ai-tool-result kubiki-scrollbar">{rawJson}</pre>}
        </div>
      )}
    </article>
  );
}
