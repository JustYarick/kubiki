import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type PointerEvent, type KeyboardEvent } from 'react';
import { useUiStore } from '../../../state/ui_store';
import { uiFactor } from '../../../core/appearance';
import { fitTableColumns } from '../../../core/resources/table_fit';
import { DEFAULT_COL_SIZE, MIN_COL, MAX_COL, type ColumnDef } from './columns';
import { useColumnReorder } from './useColumnReorder';

export function useColumnLayout({ effectiveKind, columns, uiScale, tableRef, paneRef }: { effectiveKind: string; columns: ColumnDef[]; uiScale: number; tableRef: RefObject<HTMLDivElement | null>; paneRef: RefObject<HTMLDivElement | null> }) {
  const columnWidths = useUiStore(s => s.columnWidths);
  const setColumnWidth = useUiStore(s => s.setColumnWidth);
  const setColumnOrder = useUiStore(s => s.setColumnOrder);
  const resetColumnWidths = useUiStore(s => s.resetColumnWidths);
  const resizeCleanup = useRef<() => void>(() => {});
  const resizing = useRef(false);
  const ignoreResizeClickUntil = useRef(0);
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const visibleColumnIds = ['__index', ...columns.map(column => column.id)];
  // Reordering does not change widths or rerun automatic allocation.
  const columnsSignature = [...visibleColumnIds].sort().join('|');
  const reorder = useColumnReorder(effectiveKind, columns.map(column => column.id), tableRef);
  const orderSignature = visibleColumnIds.join('|');
  useEffect(() => () => resizeCleanup.current(), [effectiveKind, orderSignature, uiScale]);

  /** Move a column left/right — the keyboard alternative to dragging the header. */
  const moveColumn = (colId: string, offset: number) => {
    const order = columns.map((column) => column.id);
    const index = order.indexOf(colId);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= order.length) return;
    const next = [...order];
    next.splice(target, 0, ...next.splice(index, 1));
    setColumnOrder(effectiveKind, next);
  };
  const fitColumns = (force = false) => {
    if (resizing.current) return;
    const pane = tableRef.current ?? paneRef.current; if (!pane?.clientWidth) return;
    const stored = useUiStore.getState().columnWidths;
    const manual = Object.fromEntries(visibleColumnIds.filter(id => Number.isFinite(stored[`${effectiveKind}:${id}`])).map(id => [id, stored[`${effectiveKind}:${id}`]]));
    if (!force && Object.keys(manual).length) return;
    const available = Math.max(300, pane.clientWidth / uiFactor(uiScale) - 2);
    setAutoWidths(fitTableColumns(visibleColumnIds, available, DEFAULT_COL_SIZE, manual));
  };
  const fitRef = useRef(fitColumns); fitRef.current = fitColumns;
  useLayoutEffect(() => {
    fitRef.current(true);
    if (!paneRef.current) return;
    const observer = new ResizeObserver(() => fitRef.current()); observer.observe(paneRef.current);
    if (tableRef.current) observer.observe(tableRef.current);
    return () => observer.disconnect();
  }, [effectiveKind, columnsSignature, uiScale]);
  const resetWidths = () => { resetColumnWidths(effectiveKind); fitRef.current(true); };
  const widthFor = (colId: string): number =>
    Math.max(colId === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, columnWidths[`${effectiveKind}:${colId}`] ?? autoWidths[colId] ?? DEFAULT_COL_SIZE[colId] ?? 120));

  const startColResize = (e: PointerEvent, colId: string) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault();
    e.stopPropagation();
    resizeCleanup.current();
    reorder.cancelReorder();
    const pane = tableRef.current;
    const el = e.currentTarget as HTMLElement;
    const th = el.closest('th');
    if (!pane || !th) return;
    const scale = uiFactor(useUiStore.getState().uiScale);
    const header = th.getBoundingClientRect();
    const pointerId = e.pointerId;
    const grabOffset = header.right - e.clientX;
    let x = e.clientX;
    let active = true;
    let finalW = header.width / scale;
    const minW = colId === '__index' ? 28 : MIN_COL;
    resizing.current = true;
    const guide = document.createElement('div');
    guide.dataset.testid = 'column-resize-guide';
    guide.setAttribute('aria-hidden', 'true');
    Object.assign(guide.style, {
      position: 'fixed',
      width: '2px',
      background: 'var(--accent)',
      pointerEvents: 'none',
      zIndex: '65',
    });
    document.body.append(guide);

    document.body.classList.add('column-layout-resizing');
    const update = () => {
      if (!active) return;
      if (!th.isConnected) { cancel(); return; }
      const bounds = pane.getBoundingClientRect();
      const left = th.getBoundingClientRect().left;
      finalW = Math.round(Math.max(minW, Math.min(MAX_COL, (x + grabOffset - left) / scale)) * 100) / 100;
      const edge = left + finalW * scale;
      Object.assign(guide.style, { left: `${edge - 1}px`, top: `${bounds.top + pane.clientTop}px`, height: `${pane.clientHeight}px`, visibility: edge >= bounds.left && edge <= bounds.left + pane.clientWidth ? 'visible' : 'hidden' });
    };
    const finish = (commit: boolean) => {
      if (!active) return;
      active = false;
      resizing.current = false;
      resizeCleanup.current = () => {};
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('lostpointercapture', cancel);
      pane.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
      observer.disconnect();
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      guide.remove();
      document.body.classList.remove('column-layout-resizing');
      ignoreResizeClickUntil.current = Date.now() + 250;
      if (commit) setColumnWidth(effectiveKind, colId, finalW);
    };
    const move = (ev: globalThis.PointerEvent) => { if (ev.pointerId === pointerId) { x = ev.clientX; update(); } };
    const up = (ev: globalThis.PointerEvent) => { if (ev.pointerId === pointerId) { x = ev.clientX; update(); finish(true); } };
    const cancel = (ev?: Event) => { if (!(ev instanceof globalThis.PointerEvent) || ev.pointerId === pointerId) finish(false); };
    const keydown = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    resizeCleanup.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('lostpointercapture', cancel);
    pane.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
    el.setPointerCapture(pointerId);
    update();
  };

  const resizeColumnWithKeyboard = (event: KeyboardEvent, id: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const width = event.key === 'Home' ? DEFAULT_COL_SIZE[id] ?? 120
      : widthFor(id) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10);
    setColumnWidth(effectiveKind, id, Math.max(id === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, width)));
  };

  const resetColumn = (id: string) => { setColumnWidth(effectiveKind, id, DEFAULT_COL_SIZE[id] ?? 120); fitColumns(true); };
  return { resetColumn, widthFor, moveColumn, resetWidths, startColResize, resizeColumnWithKeyboard, ...reorder, ignoreHeaderClick: () => resizing.current || Date.now() < ignoreResizeClickUntil.current || reorder.ignoreReorderClick() };
}
