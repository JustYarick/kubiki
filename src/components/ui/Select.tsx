import { Children, isValidElement, type ReactElement, type SelectHTMLAttributes, type OptionHTMLAttributes } from 'react';
import { selectedFirst } from '../../core/utils/selected_first';
import { cx } from '../../core/utils/cx';

export type SelectSize = 'xs' | 'sm' | 'md';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: SelectSize;
  invalid?: boolean;
}

const selectSizeCls: Record<SelectSize, string> = {
  xs: 'h-[var(--control-h-xs)] text-[length:var(--font-size-2xs)] px-1.5',
  sm: 'h-[var(--control-h-sm)] text-[length:var(--font-size-xs)] px-2',
  md: 'h-[var(--control-h-md)] text-[length:var(--font-size-sm)] px-2',
};

/** Native keyboard/accessibility behavior with the current choice at the top. */
export function Select({ children, value, defaultValue, size, invalid, className, ...props }: SelectProps) {
  const selected = new Set([value ?? defaultValue].flat().filter(entry => entry !== undefined).map(String));
  const options = selectedFirst(Children.toArray(children), child => {
    if (!isValidElement<OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== 'option') return false;
    const option = child as ReactElement<OptionHTMLAttributes<HTMLOptionElement>>;
    return selected.has(String(option.props.value ?? option.props.children));
  });
  const baseClass = size
    ? cx(
        'ide-select rounded-[var(--radius-sm)] border bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none transition-colors min-w-0',
        invalid ? 'border-[var(--status-danger)]' : 'border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)]',
        selectSizeCls[size],
        className,
      )
    : cx(invalid && 'border-[var(--status-danger)]', className);

  return (
    <select {...props} aria-invalid={invalid || props['aria-invalid']} className={baseClass} value={value} defaultValue={defaultValue}>
      {options}
    </select>
  );
}
