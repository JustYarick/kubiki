import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { uiPixels } from '../../core/appearance';

/* ============================================================= */
/* Floating layer rendered into document.body, anchored to the    */
/* trigger element. Closes on outside click / Esc / scroll.       */
/* ============================================================= */

export interface PopoverProps {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactElement<React.HTMLAttributes<HTMLElement> & React.RefAttributes<HTMLElement>>;
  children: (close: () => void) => React.ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
}

export function Popover({ trigger, children, align = 'start', width, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const update = () => {
      const r = anchorRef.current!.getBoundingClientRect();
      const ph = panelRef.current?.offsetHeight ?? 0;
      const left = align === 'end' ? r.right - (panelRef.current?.offsetWidth ?? 0) : r.left;
      const fitsBelow = r.bottom + Math.min(ph, 340) < window.innerHeight - 8;
      setPos({
        top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - ph - 4),
        left: Math.max(8, Math.min(left, window.innerWidth - (panelRef.current?.offsetWidth ?? 240) - 8)),
      });
    };
    update();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener('resize', update);
    document.addEventListener('scroll', onScroll, true);
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { close(); anchorRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, align]);

  const openRef = useRef(open);
  openRef.current = open;

  const triggerEl = trigger({ open, toggle });
  const ownProps = triggerEl.props;
  return (
    <>
      {React.cloneElement(triggerEl, {
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          const wasOpen = openRef.current;
          ownProps.onClick?.(e);
          // Only toggle if the child's own onClick didn't already toggle it
          if (openRef.current === wasOpen) {
            setOpen(!wasOpen);
          }
        },
        'aria-expanded': open,
        ref: (node: HTMLElement | null) => {
          anchorRef.current = node;
        },
      })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: width ? uiPixels(width) : undefined, maxWidth: 'calc(100vw - 16px)' }}
            className={cx(
              'fixed z-[70] min-w-[calc(180px*var(--ui-factor))] rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)]',
              'shadow-[var(--shadow-popup)] py-1 max-h-[70vh] overflow-y-auto kubiki-scrollbar kub-pop',
              className
            )}
          >
            {children(close)}
          </div>,
          document.body
        )}
    </>
  );
}

/* ============================================================= */
/* Menu model                                                    */
/* ============================================================= */

export interface MenuItem {
  id: string;
  label: string;
  kbd?: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  items?: MenuItem[]; // simple submenu (RMB expanding)
  onSelect?: () => void;
}

export function MenuList({ items, onSelect, autoFocus = false, onBack }: { items: MenuItem[]; onSelect: (item: MenuItem) => void; autoFocus?: boolean; onBack?: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ id: string; x: number; y: number; keyboard: boolean } | null>(null);
  const subItems = items.find((item) => item.id === submenu?.id)?.items;
  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [autoFocus]);
  useLayoutEffect(() => {
    if (!submenu || !submenuRef.current) return;
    const rect = submenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(submenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(submenu.y, window.innerHeight - rect.height - 8));
    if (x !== submenu.x || y !== submenu.y) setSubmenu({ ...submenu, x, y });
  }, [submenu]);
  const openSubmenu = (button: HTMLButtonElement, item: MenuItem, keyboard: boolean) => {
    if (!item.items || item.disabled) return;
    const rect = button.getBoundingClientRect();
    parentRef.current = button;
    setSubmenu({ id: item.id, x: rect.right - 4, y: rect.top - 4, keyboard });
  };
  const back = () => { setSubmenu(null); parentRef.current?.focus(); };
  return (
    <div ref={rootRef} role="group" aria-label="Actions" onKeyDown={(event) => {
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons[buttons.length - 1]
        : event.key === 'ArrowDown' ? buttons[(index + 1) % buttons.length]
        : event.key === 'ArrowUp' ? buttons[(index - 1 + buttons.length) % buttons.length] : undefined;
      if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
      if (onBack && (event.key === 'ArrowLeft' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); onBack(); }
    }}>
      {items.map((item) => item.separator ? <div key={item.id} className="my-1 h-px bg-[var(--border-subtle)]" /> : (
        <button key={item.id} disabled={item.disabled} aria-pressed={item.checked}
          aria-expanded={item.items ? submenu?.id === item.id : undefined} aria-haspopup={item.items ? 'true' : undefined}
          onMouseEnter={(event) => { if (item.items) openSubmenu(event.currentTarget, item, false); else setSubmenu(null); }}
          onKeyDown={(event) => { if (event.key === 'ArrowRight' && item.items) { event.preventDefault(); event.stopPropagation(); openSubmenu(event.currentTarget, item, true); } }}
          onClick={(event) => { if (item.items) { openSubmenu(event.currentTarget, item, true); return; } if (!item.disabled) onSelect(item); }}
          className={cx('flex w-full items-center gap-2 px-2.5 h-[calc(24px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] transition-colors text-left', item.disabled ? 'text-[var(--text-disabled)] cursor-not-allowed' : item.danger ? 'text-[var(--status-danger)] hover:bg-[var(--status-danger)]/12' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]')}>
          {item.icon && <item.icon size="calc(14px * var(--ui-factor))" strokeWidth={1.75} className="text-[var(--text-muted)] shrink-0" />}
          <span className="flex-1 truncate">{item.label}</span>
          {item.checked === true && <Check size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />}
          {item.kbd && <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{shortcutLabel(item.kbd)}</span>}
          {item.items && <ChevronRight size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)]" />}
        </button>
      ))}
      {submenu && subItems && createPortal(
        <div ref={submenuRef} data-menu-layer style={{ top: submenu.y, left: submenu.x }}
          className="fixed z-[86] min-w-[calc(170px*var(--ui-factor))] max-h-[70vh] overflow-auto rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] py-1">
          <MenuList items={subItems} autoFocus={submenu.keyboard} onBack={back} onSelect={(item) => { setSubmenu(null); onSelect(item); }} />
        </div>, document.body)}
    </div>
  );
}

/** Context menu rendered at a fixed screen position (used for right-click menus). */
export function FixedMenu({
  rect,
  items,
  onClose,
}: {
  rect: { x: number; y: number };
  items: MenuItem[];
  onClose: (item?: MenuItem) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: rect.y, left: rect.x });

  useEffect(() => {
    const h = panelRef.current?.offsetHeight ?? 200;
    const w = panelRef.current?.offsetWidth ?? 200;
    setPos({
      top: Math.min(rect.y, window.innerHeight - h - 8),
      left: Math.min(rect.x, window.innerWidth - w - 8),
    });
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || (e.target instanceof Element && e.target.closest('[data-menu-layer]'))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('scroll', onClose as unknown as EventListener, true);
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('scroll', onClose as unknown as EventListener, true);
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [rect, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-[85] min-w-[calc(200px*var(--ui-factor))] rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] py-1 kub-pop kubiki-scrollbar max-h-[70vh] overflow-y-auto"
    >
      <MenuList items={items} autoFocus onSelect={(item) => { onClose(); item.onSelect?.(); }} />
    </div>,
    document.body
  );
}
