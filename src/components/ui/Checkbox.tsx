import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../core/utils/cx';
import './responsive.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
}

export function Checkbox({ className, indeterminate, ...props }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return <input ref={ref} {...props} type="checkbox" className={cx('ui-checkbox', className)} />;
}

/** The control and trailing value keep their space; only the label may truncate. */
export function CheckboxRow({
  label,
  trailing,
  className,
  title,
  ...props
}: Omit<CheckboxProps, 'className'> & {
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
