import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { uiPixels } from '../../core/appearance';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface BaseProps {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  className?: string;
}

const variantCls: Record<Variant, string> = {
  primary: 'bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)] active:bg-[#2e63d4] border border-transparent',
  secondary:
    'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
  ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-transparent',
  danger: 'bg-transparent text-[var(--status-danger)] border border-[var(--status-danger)]/40 hover:bg-[var(--status-danger)]/15',
};

const sizeCls: Record<Size, string> = {
  sm: 'h-[calc(22px*var(--ui-factor))] px-2 text-[length:calc(11px*var(--ui-factor))] gap-1.5 rounded-[calc(4px*var(--ui-factor))]',
  md: 'h-[calc(26px*var(--ui-factor))] px-2.5 text-xs gap-1.5 rounded-[calc(4px*var(--ui-factor))]',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  BaseProps & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cx(
      'inline-flex items-center justify-center font-medium select-none transition-colors shrink-0',
      'focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)]',
      variantCls[variant],
      sizeCls[size],
      (disabled || loading) && 'opacity-45 cursor-not-allowed',
      className
    )}
    {...rest}
  >
    {loading ? <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full" /> : null}
    {children}
  </button>
));
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
            'pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[calc(4px*var(--ui-factor))] border border-[var(--border-default)]',
            'bg-[var(--bg-overlay)] px-2 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-primary)] shadow-[var(--shadow-popup)] z-[80]',
            side === 'bottom' ? 'top-[calc(100%+calc(6px*var(--ui-factor)))]' : 'bottom-[calc(100%+calc(6px*var(--ui-factor)))]'
          )}
        >
          {typeof label === 'string' ? shortcutLabel(label) : label}
        </span>
      )}
    </span>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  size?: Size;
  active?: boolean;
  danger?: boolean;
  tooltip?: React.ReactNode;
  tooltipSide?: 'top' | 'bottom';
}

const iconSizeCls = { sm: 'h-6 w-6', md: 'h-7 w-7' } as const;

export const IconButton = ({ icon: Icon, size = 'md', active, danger, tooltip, tooltipSide = 'bottom', className, ...rest }: IconButtonProps) => {
  const btn = (
    <button
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
      <Icon size={uiPixels(size === 'sm' ? 13 : 15)} strokeWidth={1.75} />
    </button>
  );
  return tooltip ? <Tooltip label={tooltip} side={tooltipSide}>{btn}</Tooltip> : btn;
};
