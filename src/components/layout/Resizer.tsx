import React, { useRef, useEffect } from 'react';
import { cx } from '../../core/utils/cx';

/**
 * Invisible 1px hit-area handle dragged to resize a neighbouring panel.
 * `vertical` = drag horizontally to change widths, `horizontal` = drag vertically for heights.
 */
export function Resizer({
  orientation,
  onDelta,
  onStart,
  className,
}: {
  orientation: 'vertical' | 'horizontal';
  onDelta: (delta: number) => void;
  onStart?: () => void;
  className?: string;
}) {
  const active = useRef(false);
  const last = useRef(0);

  const cleanup = () => {
    active.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  useEffect(() => () => { if (active.current) cleanup(); }, []);

  const pos = (e: React.PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={orientation === 'vertical' ? 'Resize panels' : 'Resize bottom panel'}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const delta = orientation === 'vertical' ? event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0 : event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
        if (delta) { event.preventDefault(); onDelta(delta); }
      }}
      onPointerCancel={cleanup}
      onLostPointerCapture={cleanup}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        active.current = true;
        last.current = pos(e);
        document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        onStart?.();
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        const cur = pos(e);
        const d = cur - last.current;
        last.current = cur;
        onDelta(d);
      }}
      onPointerUp={(e) => {
        if (!active.current) return;
        active.current = false;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }}
      className={cx(
        'group relative shrink-0 z-20',
        orientation === 'vertical' ? 'w-[calc(5px*var(--ui-factor))] -mx-[calc(2px*var(--ui-factor))] cursor-col-resize' : 'h-[calc(5px*var(--ui-factor))] -my-[calc(2px*var(--ui-factor))] cursor-row-resize',
        className
      )}
    >
      <span
        className={cx(
          'absolute transition-colors',
          orientation === 'vertical' ? 'inset-y-0 left-1/2 -translate-x-1/2 w-px' : 'inset-x-0 top-1/2 -translate-y-1/2 h-px',
          'bg-transparent group-hover:bg-[var(--accent)]/70',
          className
        )}
      />
    </div>
  );
}
