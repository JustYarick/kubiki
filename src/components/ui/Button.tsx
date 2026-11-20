import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { uiPixels } from '../../core/appearance';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: LucideIcon;
  className?: string;
}

const variantCls: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)] active:bg-[#2e63d4] border border-transparent',
  secondary:
    'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
  ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-transparent',
  danger: 'bg-transparent text-[var(--status-danger)] border border-[var(--status-danger)]/40 hover:bg-[var(--status-danger)]/15',
};

const sizeCls: Record<ButtonSize, string> = {
  xs: 'h-[var(--control-h-xs)] px-1.5 text-[length:var(--font-size-2xs)] gap-1 rounded-[var(--radius-xs)]',
  sm: 'h-[var(--control-h-sm)] px-2 text-[length:var(--font-size-xs)] gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-[var(--control-h-md)] px-2.5 text-[length:var(--font-size-sm)] gap-1.5 rounded-[var(--radius-sm)]',
  lg: 'h-[var(--control-h-lg)] px-3 text-[length:var(--font-size-base)] gap-2 rounded-[var(--radius-sm)]',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', loading, fullWidth, icon: Icon, className, children, disabled, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-medium select-none transition-colors shrink-0',
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)]',
        variantCls[variant],
        sizeCls[size],
        fullWidth && 'w-full',
        (disabled || loading) && 'opacity-45 cursor-not-allowed',
        className
      )}
      {...rest}
    >
      {loading ? (
        <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
      ) : Icon ? (
        <Icon size={uiPixels(size === 'xs' ? 11 : size === 'sm' ? 12 : 14)} aria-hidden="true" className="shrink-0" />
      ) : null}
      {children}
    </button>
  )
);
Button.displayName = 'Button';

/** Delayed CSS-free tooltip that follows the trigger position. */
export function Tooltip({
  label,
  children,
  side = 'bottom',
  delay = 500,
}: {
  label: React.ReactNode;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  side?: 'top' | 'bottom';
  delay?: number;
}) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const own = children.props;
  const clone = React.cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      own.onMouseEnter?.(e);
      timer.current = window.setTimeout(() => setVisible(true), delay);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      own.onMouseLeave?.(e);
      window.clearTimeout(timer.current);
      setVisible(false);
    },
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      own.onMouseDown?.(e);
      window.clearTimeout(timer.current);
      setVisible(false);
    },
  });

  return (
    <span className="relative inline-flex shrink-0">
      {clone}
      {visible && (
        <span
          role="tooltip"
          className={cx(
            'pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--border-default)]',
            'bg-[var(--bg-overlay)] px-2 py-1 text-[length:var(--font-size-xs)] text-[var(--text-primary)] shadow-[var(--shadow-popup)] z-[80]',
            side === 'bottom' ? 'top-[calc(100%+calc(6px*var(--ui-factor)))]' : 'bottom-[calc(100%+calc(6px*var(--ui-factor)))]'
          )}
        >
          {typeof label === 'string' ? shortcutLabel(label) : label}
        </span>
      )}
    </span>
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
  danger?: boolean;
  tooltip?: React.ReactNode;
  tooltipSide?: 'top' | 'bottom';
}

const iconSizeCls = {
  xs: 'h-[var(--control-h-xs)] w-[var(--control-h-xs)]',
  sm: 'h-[var(--control-h-sm)] w-[var(--control-h-sm)]',
  md: 'h-[var(--control-h-md)] w-[var(--control-h-md)]',
} as const;

export const IconButton = ({ icon: Icon, size = 'md', active, danger, tooltip, tooltipSide = 'bottom', className, type = 'button', ...rest }: IconButtonProps) => {
  const btn = (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center rounded-[calc(4px*var(--ui-factor))] transition-colors shrink-0',
        'hover:bg-[var(--bg-hover)] active:bg-[var(--bg-elevated)]',
        'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
        active && 'text-[var(--text-primary)] bg-[var(--bg-surface)]',
        danger && 'text-[var(--status-danger)] hover:text-[var(--text-on-accent)] hover:bg-[var(--status-danger)]',
        iconSizeCls[size],
        className
      )}
      {...rest}
    >
      <Icon size={uiPixels(size === 'xs' ? 11 : size === 'sm' ? 13 : 15)} strokeWidth={1.75} />
    </button>
  );
  return tooltip ? <Tooltip label={tooltip} side={tooltipSide}>{btn}</Tooltip> : btn;
};
