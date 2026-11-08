import { forwardRef, useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { refreshInstalledSkills, splitSkillReferences, useInstalledSkills } from '../skill_catalog';
import type { SkillInfo } from '../types';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onValueChange: (value: string) => void };
export const SkillComposer = forwardRef<HTMLTextAreaElement, Props>(function SkillComposer({ value, onValueChange, onKeyDown, onFocus, onSelect, ...props }, ref) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const { skills, error } = useInstalledSkills();
  const options = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const parts = splitSkillReferences(value, new Set(skills.map(skill => skill.name)));
  const hasReferences = parts.some(part => part.skill);
  const [cursor, setCursor] = useState(value.length);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);

  const listId = `${props.id ?? 'ai-home-message'}-skills`;
  const match = value.slice(0, cursor).match(/(?:^|\s)\$([a-z0-9_-]*)$/i);
  const candidates = focused && match && !dismissed ? skills.filter(skill => skill.name.toLowerCase().includes(match[1].toLowerCase())) : [];
  useEffect(() => { setSelected(0); setDismissed(false); }, [value]);
  useEffect(() => {
    const list = options.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !active) return;
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
  }, [selected, candidates.map(skill => skill.name).join('|')]);
  useEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const sync = () => { if (highlight.current) { highlight.current.style.width = `${textarea.clientWidth}px`; highlight.current.scrollTop = textarea.scrollTop; } };
    const observer = new ResizeObserver(sync); observer.observe(textarea); sync();
    return () => observer.disconnect();
  }, [hasReferences]);
  function choose(skill: SkillInfo) {
    if (!match) return;
    const start = cursor - match[1].length - 1;
    const suffix = value.slice(cursor).replace(/^[a-z0-9_-]*/i, '');
    const next = `${value.slice(0, start)}$${skill.name} ${suffix}`;
    onValueChange(next); setDismissed(true);
    requestAnimationFrame(() => { const position = start + skill.name.length + 2; input.current?.focus(); input.current?.setSelectionRange(position, position); setCursor(position); });
  }
  return <div className={`ai-skill-composer ${hasReferences ? 'has-skill-references' : ''}`}>
    {candidates.length > 0 && <div ref={options} id={listId} role="listbox" aria-label="Installed skills" className="ai-skill-options">
      {candidates.map((skill, index) => <button type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} key={skill.name} aria-selected={index === Math.min(selected, candidates.length - 1)} onMouseMove={() => setSelected(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(skill)}><strong>${skill.name}</strong><span>{skill.description}</span></button>)}
    </div>}
    {match && error && <p role="status" className="ai-error">{error}</p>}
    {hasReferences && <div ref={highlight} className="ai-skill-highlight ai-composer-card-textarea" aria-hidden="true">{parts.map((part, index) => part.skill ? <span key={index} className="ai-skill-token">{part.text}</span> : part.text)}{'\n'}</div>}
    <textarea {...props} ref={node => { input.current = node; if (typeof ref === 'function') ref(node); else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node; }} value={value}
      aria-autocomplete="list" aria-controls={candidates.length ? listId : undefined} aria-expanded={candidates.length > 0} aria-activedescendant={candidates.length ? `${listId}-${Math.min(selected, candidates.length - 1)}` : undefined}
      onFocus={e => { setFocused(true); void refreshInstalledSkills(); setCursor(e.currentTarget.selectionStart); onFocus?.(e); }}
      onBlur={e => { setFocused(false); props.onBlur?.(e); }}
      onScroll={e => { if (highlight.current) highlight.current.scrollTop = e.currentTarget.scrollTop; props.onScroll?.(e); }}
      onSelect={e => { setCursor(e.currentTarget.selectionStart); onSelect?.(e); }}
      onChange={e => { setCursor(e.currentTarget.selectionStart); onValueChange(e.target.value); }}
      onKeyDown={e => {
        if (candidates.length && !e.nativeEvent.isComposing) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(index => (index + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(candidates[Math.min(selected, candidates.length - 1)]); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
        }
        onKeyDown?.(e);
      }} />
  </div>;
});
