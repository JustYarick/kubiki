import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';

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
    window.addEventListener('resize', update);
    document.addEventListener('scroll', close, true);
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || anchorRef.current?.parentElement?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', close, true);
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
        ref: (node: HTMLElement | null) => {
          anchorRef.current = node;
        },
      })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: width }}
            className={cx(
              'fixed z-[70] min-w-[180px] rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-overlay)]',
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

export function MenuList({ items, onSelect }: { items: MenuItem[]; onSelect: (item: MenuItem) => void }) {
  const [submenu, setSubmenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const subRef = useRef(items.find((i) => i.id === submenu?.id)?.items ?? null);
  useEffect(() => {
    subRef.current = items.find((i) => i.id === submenu?.id)?.items ?? null;
  }, [submenu, items]);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  return (
    <div>
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="my-1 h-px bg-[var(--border-subtle)]" />
        ) : (
          <button
            key={item.id}
            disabled={item.disabled}
            onMouseEnter={(e) => {
              if (!item.items) return setSubmenu(null);
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setSubPos({ x: r.right - 4, y: r.top - 4 });
              setSubmenu({ id: item.id, x: r.right - 4, y: r.top - 4 });
            }}
            onMouseLeave={() => item.items && setSubmenu(null)}
            onClick={() => {
              if (item.items || item.disabled) return;
              onSelect(item);
            }}
            className={cx(
              'flex w-full items-center gap-2 px-2.5 h-[24px] text-[12px] transition-colors text-left',
              item.disabled
                ? 'text-[var(--text-disabled)] cursor-not-allowed'
                : item.danger
                  ? 'text-[var(--status-danger)] hover:bg-[var(--status-danger)]/12'
                  : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            {item.icon && <item.icon size={14} strokeWidth={1.75} className="text-[var(--text-muted)] shrink-0" />}
            <span className="flex-1 truncate">{item.label}</span>
            {item.checked === true && <Check size={13} className="text-[var(--accent)]" />}
            {item.kbd && <span className="text-[10px] text-[var(--text-muted)]">{item.kbd}</span>}
            {item.items && <ChevronRight size={12} className="text-[var(--text-muted)]" />}
          </button>
        )
      )}
      {submenu &&
        subRef.current &&
        createPortal(
          <div
            style={{ top: Math.min(subPos.y, window.innerHeight - 260), left: Math.min(subPos.x, window.innerWidth - 200) }}
            className="fixed z-[71] min-w-[170px] rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] py-1"
          >
            <MenuList
              items={subRef.current}
              onSelect={(it) => {
                setSubmenu(null);
                onSelect(it);
              }}
            />
          </div>,
          document.body
        )}
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
      if (panelRef.current?.contains(e.target as Node)) return;
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
      className="fixed z-[85] min-w-[200px] rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] py-1 kub-pop kubiki-scrollbar max-h-[70vh] overflow-y-auto"
    >
      <MenuList items={items} onSelect={(item) => onClose(item)} />
    </div>,
    document.body
  );
}
