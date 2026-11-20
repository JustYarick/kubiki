import React from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '../../core/utils/cx';

export type InputSize = 'xs' | 'sm' | 'md' | 'lg';
export type InputVariant = 'default' | 'subtle' | 'ghost';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  size?: InputSize;
  variant?: InputVariant;
  mono?: boolean;
  clearable?: boolean;
  onClear?: () => void;
  inputClassName?: string;
}

const inputSizeCls: Record<InputSize, string> = {
  xs: 'h-[var(--control-h-xs)] text-[length:var(--font-size-xs)]',
  sm: 'h-[var(--control-h-sm)] text-[length:var(--font-size-xs)]',
  md: 'h-[var(--control-h-md)] text-[length:var(--font-size-sm)]',
  lg: 'h-[var(--control-h-lg)] text-[length:var(--font-size-base)]',
};

const inputVariantCls: Record<InputVariant, string> = {
  default: 'bg-[var(--bg-primary)] border',
  subtle: 'bg-[var(--bg-canvas)] border',
  ghost: 'bg-transparent border border-transparent hover:border-[var(--border-default)]',
};

/**
 * Shared literal-safe text input scaled with `--ui-factor`.
 * Disables WebKit/macOS spelling autocorrection by default so Kubernetes names
 * and filter queries are never rewritten on focus changes.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    inputClassName,
    invalid,
    icon,
    trailing,
    size = 'md',
    variant = 'default',
    mono = false,
    clearable = false,
    onClear,
    value,
    ...rest
  },
  ref,
) {
  const showClear = clearable && typeof value === 'string' && value.length > 0 && !rest.disabled;
  return (
    <div className={cx('relative flex items-center min-w-0', className)}>
      {icon && (
        <span className="absolute left-2 text-[var(--text-muted)] pointer-events-none flex items-center" aria-hidden="true">
          {icon}
        </span>
      )}
      <input
        ref={ref}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        aria-invalid={invalid || rest['aria-invalid']}
        className={cx(
          inputSizeCls[size],
          inputVariantCls[variant],
          'w-full min-w-0 text-[var(--text-primary)] rounded-[var(--radius-sm)] outline-none transition-colors',
          'placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed',
          invalid
            ? 'border-[var(--status-danger)] focus:border-[var(--status-danger)]'
            : variant !== 'ghost' && 'border-[var(--border-default)] hover:border-[var(--border-strong)]',
          mono && 'font-mono',
          icon ? 'pl-7' : 'px-2',
          showClear || trailing ? 'pr-7' : icon ? 'pr-2' : undefined,
          inputClassName,
        )}
        {...rest}
      />
      {(showClear || trailing) && (
        <div className="absolute right-1 flex items-center gap-0.5">
          {trailing}
          {showClear && (
            <button
              type="button"
              aria-label="Clear input"
              title="Clear"
              onClick={() => onClear?.()}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded-[var(--radius-xs)]"
            >
              <X size="calc(12px * var(--ui-factor))" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
  resize?: 'none' | 'vertical' | 'both';
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, mono = false, resize = 'vertical', ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || rest['aria-invalid']}
      className={cx(
        'w-full min-w-0 rounded-[var(--radius-sm)] border bg-[var(--bg-primary)] px-2 py-1.5 text-[length:var(--font-size-sm)] text-[var(--text-primary)] outline-none transition-colors',
        'placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed',
        invalid
          ? 'border-[var(--status-danger)] focus:border-[var(--status-danger)]'
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]',
        mono && 'font-mono',
        resize === 'none' ? 'resize-none' : resize === 'both' ? 'resize' : 'resize-y',
        className,
      )}
      {...rest}
    />
  );
});
Textarea.displayName = 'Textarea';

export interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
  size?: InputSize;
  variant?: InputVariant;
  refCb?: React.Ref<HTMLInputElement>;
  isRegex?: boolean;
  onToggleRegex?: (isRegex: boolean) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  clearable?: boolean;
  clearOnEscape?: boolean;
  clearLabel?: string;
  inputProps?: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'placeholder' | 'size' | 'className' | 'onKeyDown'
  >;
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as React.MutableRefObject<T | null>).current = value;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  {
    value,
    onChange,
    placeholder,
    ariaLabel,
    className,
    inputClassName,
    size = 'md',
    variant = 'default',
    refCb,
    isRegex = false,
    onToggleRegex,
    onKeyDown,
    clearable = true,
    clearOnEscape = clearable,
    clearLabel = 'Clear search',
    inputProps,
  },
  forwardedRef,
) {
  let regexError = '';
  if (isRegex && value.trim()) {
    try {
      new RegExp(value.trim());
    } catch (err) {
      regexError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div className={cx('relative flex items-center min-w-0', className)}>
      <Search
        size="calc(13px * var(--ui-factor))"
        className="absolute left-2 text-[var(--text-muted)] pointer-events-none"
        aria-hidden="true"
      />
      <input
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        {...inputProps}
        ref={(node) => {
          assignRef(forwardedRef, node);
          assignRef(refCb, node);
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && clearOnEscape && value) {
            onChange('');
          }
          if (e.altKey && e.key.toLowerCase() === 'r' && onToggleRegex) {
            e.preventDefault();
            onToggleRegex(!isRegex);
          }
        }}
        aria-label={ariaLabel ?? inputProps?.['aria-label'] ?? placeholder ?? 'Search'}
        title={regexError ? `Invalid regex: ${regexError}` : inputProps?.title ?? placeholder}
        placeholder={placeholder}
        className={cx(
          inputSizeCls[size],
          inputVariantCls[variant],
          'w-full min-w-0 text-[var(--text-primary)] rounded-[var(--radius-sm)] outline-none transition-colors',
          regexError
            ? 'border-[var(--status-danger)] focus:border-[var(--status-danger)]'
            : variant !== 'ghost' && 'border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)]',
          'placeholder:text-[var(--text-muted)] pl-7',
          onToggleRegex ? (clearable && value ? 'pr-14' : 'pr-8') : (clearable && value ? 'pr-6' : 'pr-2'),
          inputClassName,
        )}
      />
      {(onToggleRegex || (clearable && value)) && (
        <div className="absolute right-1 flex items-center gap-0.5">
          {onToggleRegex && (
            <button
              type="button"
              aria-label="Use regular expression (Alt+R)"
              aria-pressed={isRegex}
              title={isRegex ? 'Regular expression mode (Alt+R) - Active' : 'Use regular expression (Alt+R)'}
              onClick={() => onToggleRegex(!isRegex)}
              className={cx(
                'h-[var(--control-h-xs)] px-1 rounded-[var(--radius-xs)] font-mono text-[length:var(--font-size-2xs)] font-semibold leading-none flex items-center justify-center transition-colors',
                isRegex
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              .*
            </button>
          )}
          {clearable && value && (
            <button
              type="button"
              aria-label={clearLabel}
              title={clearLabel}
              onClick={() => onChange('')}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded-[var(--radius-xs)]"
            >
              <X size="calc(12px * var(--ui-factor))" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
SearchInput.displayName = 'SearchInput';

export function Label({ children, className, htmlFor }: { children: React.ReactNode; className?: string; htmlFor?: string }) {
  const Element = htmlFor ? 'label' : 'div';
  return <Element htmlFor={htmlFor} className={cx('text-[length:var(--font-size-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]', className)}>{children}</Element>;
}
