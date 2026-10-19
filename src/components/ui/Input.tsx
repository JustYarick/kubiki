import React from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '../../core/utils/cx';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  icon?: React.ReactNode;
}

export function Input({ className, invalid, icon, ...rest }: InputProps) {
  return (
    <div className={cx('relative flex items-center', className)}>
      {icon && <span className="absolute left-2 text-[var(--text-muted)] pointer-events-none">{icon}</span>}
      <input
        className={cx(
          'h-[26px] w-full bg-[var(--bg-primary)] text-xs text-[var(--text-primary)] rounded-[4px] border outline-none transition-colors',
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
  refCb?: React.Ref<HTMLInputElement>;
}

export function SearchInput({ value, onChange, placeholder, className, refCb }: SearchInputProps) {
  return (
    <div className={cx('relative flex items-center', className)}>
      <Search size={13} className="absolute left-2 text-[var(--text-muted)] pointer-events-none" />
      <input
        ref={refCb}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={placeholder}
        className={cx(
          'h-[26px] w-full bg-[var(--bg-primary)] text-xs text-[var(--text-primary)] rounded-[4px] border outline-none transition-colors',
          'border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)]',
          'placeholder:text-[var(--text-muted)] pl-7 pr-6'
        )}
      />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx('text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]', className)}>{children}</div>;
}
