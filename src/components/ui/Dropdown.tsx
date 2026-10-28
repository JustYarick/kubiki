import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { uiPixels } from '../../core/appearance';
import { selectedFirst } from '../../core/utils/selected_first';

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
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: window.innerHeight * 0.7 });

  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    let anchorTop = 0;
    let anchorLeft = 0;
    const update = () => {
      const r = anchorRef.current!.getBoundingClientRect();
      anchorTop = r.top;
      anchorLeft = r.left;
      const panel = panelRef.current;
      const desiredHeight = Math.min(panel?.scrollHeight ?? 0, window.innerHeight * 0.7);
      const below = Math.max(0, window.innerHeight - r.bottom - 12);
      const above = Math.max(0, r.top - 12);
      const fitsBelow = desiredHeight <= below || below >= above;
      const maxHeight = Math.max(0, Math.min(window.innerHeight * 0.7, fitsBelow ? below : above));
      const ph = Math.min(panel?.offsetHeight ?? 0, maxHeight);
      const left = align === 'end' ? r.right - (panelRef.current?.offsetWidth ?? 0) : r.left;
      const next = {
        top: Math.max(8, Math.min(fitsBelow ? r.bottom + 4 : r.top - ph - 4, window.innerHeight - ph - 8)),
        left: Math.max(8, Math.min(left, window.innerWidth - (panelRef.current?.offsetWidth ?? 240) - 8)),
        maxHeight,
      };
      setPos(previous => previous.top === next.top && previous.left === next.left && previous.maxHeight === next.maxHeight ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchorRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      // A queued scroll from revealing the trigger can arrive after opening.
      // Close only when scrolling actually moves the anchor away from the panel.
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (anchor && anchor.top === anchorTop && anchor.left === anchorLeft) return;
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
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, align, width]);

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
            data-floating-panel
            onKeyDown={event => {
              if (event.key !== 'Escape' || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              close();
              anchorRef.current?.focus();
            }}
            style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight, width: width ? uiPixels(width) : undefined, minWidth: 'min(calc(180px * var(--ui-factor)), calc(100vw - 16px))', maxWidth: 'calc(100vw - 16px)' }}
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
  header?: boolean;
  items?: MenuItem[]; // simple submenu (RMB expanding)
  onSelect?: () => void;
}

function menuSelectionOrder(items: MenuItem[]): MenuItem[] {
  const ordered: MenuItem[] = []; let choices: MenuItem[] = [];
  const flush = () => { ordered.push(...selectedFirst(choices, item => item.checked === true)); choices = []; };
  for (const item of items) {
    if (item.checked !== undefined && !item.header && !item.separator) choices.push(item);
    else { flush(); ordered.push(item); }
  }
  flush();
  return ordered;
}

export function MenuList({ items, onSelect, autoFocus = false, onBack }: { items: MenuItem[]; onSelect: (item: MenuItem) => void; autoFocus?: boolean; onBack?: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ id: string; x: number; y: number; keyboard: boolean } | null>(null);
  const subItems = items.find((item) => item.id === submenu?.id)?.items;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && rootRef.current?.contains(focused)) focused.scrollIntoView({ block: 'nearest' });
  }, [items]);
  useEffect(() => {
    if (autoFocus) (rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? rootRef.current)?.focus();
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
    <div ref={rootRef} role="group" tabIndex={-1} aria-label="Actions" onKeyDown={(event) => {
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons[buttons.length - 1]
        : event.key === 'ArrowDown' ? buttons[(index + 1) % buttons.length]
        : event.key === 'ArrowUp' ? buttons[(index - 1 + buttons.length) % buttons.length] : undefined;
      if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
      if (onBack && (event.key === 'ArrowLeft' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); onBack(); }
    }}>
      {menuSelectionOrder(items).map((item) => item.separator ? <div key={item.id} className="my-1 h-px bg-[var(--border-subtle)]" /> : item.header ? (
        <div key={item.id} className="px-2.5 pt-1.5 pb-0.5 text-[length:calc(9.5px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)] select-none">
          {item.label}
        </div>
      ) : (
        <button key={item.id} disabled={item.disabled} aria-pressed={item.checked}
          aria-expanded={item.items ? submenu?.id === item.id : undefined} aria-haspopup={item.items ? 'true' : undefined}
          onMouseEnter={(event) => { if (item.items) openSubmenu(event.currentTarget, item, false); else setSubmenu(null); }}
          onKeyDown={(event) => { if (event.key === 'ArrowRight' && item.items) { event.preventDefault(); event.stopPropagation(); openSubmenu(event.currentTarget, item, true); } }}
          onClick={(event) => { if (item.items) { openSubmenu(event.currentTarget, item, true); return; } if (!item.disabled) onSelect(item); }}
          className={cx('flex w-full items-center gap-2 px-2.5 h-[calc(24px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] transition-colors text-left', item.disabled ? 'text-[var(--text-disabled)] cursor-not-allowed' : item.danger ? 'text-[var(--status-danger)] hover:bg-[var(--status-danger)]/12' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]')}>
          {item.icon && <item.icon size="calc(14px * var(--ui-factor))" strokeWidth={1.75} className="text-[var(--text-muted)] shrink-0" />}
          <span className="flex-1 min-w-0 truncate" title={item.label}>{item.label}</span>
          {item.checked === true && <Check size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />}
          {item.kbd && <span className="max-w-[40%] truncate text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{shortcutLabel(item.kbd)}</span>}
          {item.items && <ChevronRight size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />}
        </button>
      ))}
      {submenu && subItems && createPortal(
        <div ref={submenuRef} data-menu-layer style={{ top: submenu.y, left: submenu.x, minWidth: 'min(calc(170px * var(--ui-factor)), calc(100vw - 16px))', maxWidth: 'calc(100vw - 16px)' }}
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
      top: Math.max(8, Math.min(rect.y, window.innerHeight - h - 8)),
      left: Math.max(8, Math.min(rect.x, window.innerWidth - w - 8)),
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
      style={{ top: pos.top, left: pos.left, minWidth: 'min(calc(200px * var(--ui-factor)), calc(100vw - 16px))', maxWidth: 'calc(100vw - 16px)' }}
      className="fixed z-[85] min-w-[calc(200px*var(--ui-factor))] rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] py-1 kub-pop kubiki-scrollbar max-h-[70vh] overflow-y-auto"
    >
      <MenuList items={items} autoFocus onSelect={(item) => { onClose(); item.onSelect?.(); }} />
    </div>,
    document.body
  );
}
