import React from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '../../core/utils/cx';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
}

export function Input({ className, invalid, icon, size = 'md', ...rest }: InputProps) {
  return (
    <div className={cx('relative flex items-center', className)}>
      {icon && <span className="absolute left-2 text-[var(--text-muted)] pointer-events-none">{icon}</span>}
      <input
        className={cx(
          size === 'sm' ? 'h-[var(--control-h-sm)] text-[length:var(--font-size-xs)]' : 'h-[var(--control-h-md)] text-[length:var(--font-size-sm)]',
          'w-full bg-[var(--bg-primary)] text-[var(--text-primary)] rounded-[var(--radius-sm)] border outline-none transition-colors',
          'placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]',
          invalid ? 'border-[var(--status-danger)]' : 'border-[var(--border-default)] hover:border-[var(--border-strong)]',
          icon ? 'pl-7 pr-2' : 'px-2'
        )}
        {...rest}
      />
    </div>
  );
}

interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  refCb?: React.Ref<HTMLInputElement>;
  isRegex?: boolean;
  onToggleRegex?: (isRegex: boolean) => void;
}

export function SearchInput({ value, onChange, placeholder, className, size = 'md', refCb, isRegex = false, onToggleRegex }: SearchInputProps) {
  let regexError = '';
  if (isRegex && value.trim()) {
    try {
      new RegExp(value.trim());
    } catch (err) {
      regexError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div className={cx('relative flex items-center', className)}>
      <Search size="calc(13px * var(--ui-factor))" className="absolute left-2 text-[var(--text-muted)] pointer-events-none" />
      <input
        ref={refCb}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
          if (e.altKey && e.key.toLowerCase() === 'r' && onToggleRegex) {
            e.preventDefault();
            onToggleRegex(!isRegex);
          }
        }}
        aria-label={placeholder || "Search"}
        title={regexError ? `Invalid regex: ${regexError}` : placeholder}
        placeholder={placeholder}
        className={cx(
          size === 'sm' ? 'h-[var(--control-h-sm)] text-[length:var(--font-size-xs)]' : 'h-[var(--control-h-md)] text-[length:var(--font-size-sm)]',
          'w-full bg-[var(--bg-primary)] text-[var(--text-primary)] rounded-[var(--radius-sm)] border outline-none transition-colors',
          regexError
            ? 'border-[var(--status-danger)] focus:border-[var(--status-danger)]'
            : 'border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)]',
          'placeholder:text-[var(--text-muted)] pl-7',
          onToggleRegex ? (value ? 'pr-14' : 'pr-8') : (value ? 'pr-6' : 'pr-2')
        )}
      />
      <div className="absolute right-1 flex items-center gap-0.5">
        {onToggleRegex && (
          <button
            type="button"
            aria-label="Use regular expression (Alt+R)"
            aria-pressed={isRegex}
            title={isRegex ? "Regular expression mode (Alt+R) - Active" : "Use regular expression (Alt+R)"}
            onClick={() => onToggleRegex(!isRegex)}
            className={cx(
              'h-[var(--control-h-xs)] px-1 rounded-[var(--radius-xs)] font-mono text-[length:var(--font-size-2xs)] font-semibold leading-none flex items-center justify-center transition-colors',
              isRegex
                ? 'bg-[var(--accent)] text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            .*
          </button>
        )}
        {value && (
          <button aria-label="Clear search" title="Clear search" onClick={() => onChange('')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded-[var(--radius-xs)]">
            <X size="calc(12px * var(--ui-factor))" />
          </button>
        )}
      </div>
    </div>
  );
}

export function Label({ children, className, htmlFor }: { children: React.ReactNode; className?: string; htmlFor?: string }) {
  const Element = htmlFor ? 'label' : 'div';
  return <Element htmlFor={htmlFor} className={cx('text-[length:var(--font-size-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]', className)}>{children}</Element>;
}
