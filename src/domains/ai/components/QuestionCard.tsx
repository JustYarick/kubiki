import React, { useState } from 'react';
import { Check, CheckCircle2, HelpCircle, Send } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { useAiStore } from '../store';
import type { ChatMessage, Conversation } from '../types';

export function QuestionCard({ message: m, conversation: c }: { message: ChatMessage; conversation: Conversation }) {
  const [otherText, setOtherText] = useState('');
  const args = (m.call?.arguments || {}) as Record<string, any>;
  const result = m.result;
  const question = String(args.question || result?.question || 'What would you like to do next?');
  const options: string[] = Array.isArray(result?.options)
    ? result.options
    : Array.isArray(args.options)
    ? args.options
    : ['Yes', 'No'];
  const multiSelect = !!(result?.multi_select ?? args.multi_select);
  const allowOther = (result?.allow_other ?? args.allow_other) !== false;
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);

  const msgIndex = c.messages.findIndex(item => item.id === m.id);
  const answeredMsg = msgIndex >= 0 ? c.messages.slice(msgIndex + 1).find(item => item.role === 'user') : undefined;
  const isAnswered = !!answeredMsg;

  const handleSelect = (optionText: string) => {
    if (c.busy || isAnswered) return;
    useAiStore.getState().update(c.id, { draft: optionText });
    void useAiStore.getState().send(c.id);
  };

  const handleToggleOption = (optionText: string) => {
    if (c.busy || isAnswered) return;
    setSelectedMulti(prev =>
      prev.includes(optionText) ? prev.filter(x => x !== optionText) : [...prev, optionText]
    );
  };

  const handleMultiSubmit = () => {
    if (c.busy || isAnswered || selectedMulti.length === 0) return;
    const answer = selectedMulti.join(', ');
    useAiStore.getState().update(c.id, { draft: answer });
    void useAiStore.getState().send(c.id);
  };

  const handleOtherSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!otherText.trim() || c.busy || isAnswered) return;
    const text = otherText.trim();
    setOtherText('');
    useAiStore.getState().update(c.id, { draft: text });
    void useAiStore.getState().send(c.id);
  };

  return (
    <article
      className={`ai-question-card ${isAnswered ? 'is-answered' : ''}`}
      aria-label="AI tool ask_user"
    >
      <div className="ai-question-header">
        <div className="flex items-center gap-2 font-medium">
          <HelpCircle size={14} className={isAnswered ? 'text-emerald-400' : 'text-indigo-400'} aria-hidden="true" />
          <span>Agent Question</span>
          {multiSelect && !isAnswered && (
            <span className="text-[10px] text-[var(--text-muted)] font-mono">(Multi-choice)</span>
          )}
        </div>
        <span className={`ai-question-badge ${isAnswered ? 'is-answered' : ''}`}>
          {isAnswered ? 'Answered' : 'Awaiting input'}
        </span>
      </div>

      <p className="ai-question-text">{question}</p>

      {isAnswered ? (
        <div className="ai-question-answered-box">
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold mb-1">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>Your response:</span>
          </div>
          <p className="ai-question-answered-content">{answeredMsg.text}</p>
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div className="ai-question-options" role="group" aria-label="Suggested responses">
              {multiSelect ? (
                <>
                  {options.map((opt, idx) => {
                    const checked = selectedMulti.includes(opt);
                    return (
                      <label key={idx} className={`ai-question-checkbox-row ${checked ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          className="ui-checkbox"
                          checked={checked}
                          disabled={c.busy}
                          onChange={() => handleToggleOption(opt)}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                  <div className="w-full ai-question-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={c.busy || selectedMulti.length === 0}
                      onClick={handleMultiSubmit}
                    >
                      <Check size={12} aria-hidden="true" />
                      <span>Confirm selection ({selectedMulti.length})</span>
                    </Button>
                  </div>
                </>
              ) : (
                options.map((opt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="ai-question-option-btn"
                    disabled={c.busy}
                    onClick={() => handleSelect(opt)}
                  >
                    <span className="ai-question-choice-dot" aria-hidden="true" />
                    <span>{opt}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {allowOther && (
            <form onSubmit={handleOtherSubmit} className="ai-question-other">
              <input
                type="text"
                className="ide-input ai-question-other-input"
                placeholder="Type custom response…"
                value={otherText}
                disabled={c.busy}
                onChange={e => setOtherText(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!otherText.trim() || c.busy}
                type="submit"
              >
                <Send size={12} aria-hidden="true" />
                <span>Reply</span>
              </Button>
            </form>
          )}
        </>
      )}
    </article>
  );
}
