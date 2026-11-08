import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../core/utils/cx';
import './responsive.css';

export function Checkbox({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input {...props} type="checkbox" className={cx('ui-checkbox', className)} />;
}

/** The control and trailing value keep their space; only the label may truncate. */
export function CheckboxRow({
  label,
  trailing,
  className,
  title,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  label: string;
  trailing?: ReactNode;
  className?: string;
  title?: string;
}) {
  const tooltip = title ?? label;
  return <label className={cx('ui-checkbox-row cursor-pointer', className)} title={tooltip}>
    <Checkbox {...props} title={tooltip} />
    <span className="ui-checkbox-label" title={tooltip}>{label}</span>
    {trailing != null && <span className="ui-checkbox-trailing">{trailing}</span>}
  </label>;
}
