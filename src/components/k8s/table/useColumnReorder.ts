import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { useUiStore } from '../../../state/ui_store';

interface DropTarget { id: string; edge: 'before' | 'after' }

/** Pointer capture keeps header movement separate from native HTML drag and column resizing. */
export function useColumnReorder(kind: string, columnIds: string[], tableRef: RefObject<HTMLDivElement | null>) {
  const setColumnOrder = useUiStore(state => state.setColumnOrder);
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const ignoreClickUntil = useRef(0);
  const signature = columnIds.join('|');
  useEffect(() => () => cleanup.current(), [kind, signature]);

  const startColReorder = (event: PointerEvent<HTMLTableCellElement>, source: string) => {
    if (event.button !== 0 || event.isPrimary === false || (event.target as HTMLElement).closest('button, [role="separator"], input, select, a')) return;
    cleanup.current();
    const pane = tableRef.current;
    if (!pane) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let x = startX, y = startY;
    let active = true, moved = false, frame = 0;
    let target: DropTarget | null = null;

    const updateTarget = () => {
      const bounds = pane.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      const cells = [...pane.querySelectorAll<HTMLTableCellElement>('th[data-column-id]')].map(cell => ({ id: cell.dataset.columnId!, rect: cell.getBoundingClientRect() }));
      let next: DropTarget | null = null;
      if (x >= bounds.left && x <= bounds.left + pane.clientWidth && y >= row.top - 12 && y <= row.bottom + 12) {
        const cell = cells.find(cell => x < cell.rect.right) ?? cells[cells.length - 1];
        if (cell && cell.id !== source) next = { id: cell.id, edge: x < cell.rect.left + cell.rect.width / 2 ? 'before' : 'after' };
      }
      target = next;
      setDropTarget(previous => previous?.id === next?.id && previous?.edge === next?.edge ? previous : next);
    };
    const autoScroll = () => {
      frame = 0;
      if (!active || !moved) return;
      const bounds = pane.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      if (y < row.top - 12 || y > row.bottom + 12) return;
      const right = bounds.left + pane.clientWidth;
      const delta = x < bounds.left + 28 ? -12 : x > right - 28 ? 12 : 0;
      const before = pane.scrollLeft;
      if (delta) pane.scrollLeft += delta;
      if (pane.scrollLeft !== before) { updateTarget(); frame = requestAnimationFrame(autoScroll); }
    };
    const finish = (commit: boolean) => {
      if (!active) return;
      active = false;
      cleanup.current = () => {};
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      element.removeEventListener('lostpointercapture', cancel);
      pane.removeEventListener('scroll', scroll);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      document.body.classList.remove('column-layout-reordering');
      setDraggingColumn(null);
      setDropTarget(null);
      if (moved) ignoreClickUntil.current = Date.now() + 250;
      if (commit && moved && target) {
        const next = columnIds.filter(id => id !== source);
        const index = next.indexOf(target.id);
        if (index < 0) return;
        next.splice(index + (target.edge === 'after' ? 1 : 0), 0, source);
        if (next.some((id, i) => id !== columnIds[i])) setColumnOrder(kind, next);
      }
    };
    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX; y = ev.clientY;
      if (!moved && Math.hypot(x - startX, y - startY) < 6) return;
      ev.preventDefault();
      if (!moved) { moved = true; element.setPointerCapture(pointerId); setDraggingColumn(source); document.body.classList.add('column-layout-reordering'); }
      updateTarget();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    const up = (ev: globalThis.PointerEvent) => { if (ev.pointerId === pointerId) { x = ev.clientX; y = ev.clientY; if (moved) updateTarget(); finish(true); } };
    const cancel = (ev?: Event) => { if (!(ev instanceof globalThis.PointerEvent) || ev.pointerId === pointerId) finish(false); };
    const scroll = () => { if (moved) updateTarget(); };
    const keydown = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    cleanup.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    element.addEventListener('lostpointercapture', cancel);
    pane.addEventListener('scroll', scroll);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
  };
  return { draggingColumn, dropTarget, startColReorder, cancelReorder: () => cleanup.current(), ignoreReorderClick: () => Date.now() < ignoreClickUntil.current };
}
