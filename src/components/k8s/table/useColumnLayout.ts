import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type PointerEvent, type KeyboardEvent } from 'react';
import { useUiStore } from '../../../state/ui_store';
import { uiFactor } from '../../../core/appearance';
import { fitTableColumns } from '../../../core/resources/table_fit';
import { DEFAULT_COL_SIZE, MIN_COL, MAX_COL, type ColumnDef } from './columns';

export function useColumnLayout({ effectiveKind, columns, uiScale, tableRef, paneRef }: { effectiveKind: string; columns: ColumnDef[]; uiScale: number; tableRef: RefObject<HTMLDivElement | null>; paneRef: RefObject<HTMLDivElement | null> }) {
  const columnWidths = useUiStore(s => s.columnWidths);
  const setColumnWidth = useUiStore(s => s.setColumnWidth);
  const setColumnOrder = useUiStore(s => s.setColumnOrder);
  const resetColumnWidths = useUiStore(s => s.resetColumnWidths);
  const resizeCleanup = useRef<() => void>(() => {});
  useEffect(() => () => resizeCleanup.current(), []);
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const visibleColumnIds = ['__index', ...columns.map(column => column.id)];
  const columnsSignature = visibleColumnIds.join('|');

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
    const pane = paneRef.current; if (!pane?.clientWidth) return;
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
    return () => observer.disconnect();
  }, [effectiveKind, columnsSignature, uiScale]);
  const resetWidths = () => { resetColumnWidths(effectiveKind); fitRef.current(true); };
  const widthFor = (colId: string): number =>
    Math.max(colId === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, columnWidths[`${effectiveKind}:${colId}`] ?? autoWidths[colId] ?? DEFAULT_COL_SIZE[colId] ?? 120));

  const startColResize = (e: PointerEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeCleanup.current();
    const pane = tableRef.current;
    if (!pane) return;
    const bounds = pane.getBoundingClientRect();
    const guide = document.createElement('div');
    guide.dataset.testid = 'column-resize-guide';
    guide.setAttribute('aria-hidden', 'true');
    Object.assign(guide.style, {
      position: 'fixed',
      width: '2px',
      background: 'var(--accent)',
      top: `${bounds.top}px`,
      height: `${pane.clientHeight}px`,
      pointerEvents: 'none',
      zIndex: '65',
    });
    document.body.append(guide);

    const scale = uiFactor(useUiStore.getState().uiScale);
    const th = (e.currentTarget as HTMLElement).closest('th');
    const headerLeft = th?.getBoundingClientRect().left ?? bounds.left;
    const startW = widthFor(colId);
    const startX = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    guide.style.left = `${Math.min(bounds.right - 2, headerLeft + startW * scale)}px`;
    el.style.background = 'var(--accent)';

    let finalW = startW;
    const minW = colId === '__index' ? 28 : MIN_COL;
    const maxW = MAX_COL;

    const move = (ev: globalThis.PointerEvent) => {
      const currentScale = uiFactor(useUiStore.getState().uiScale);
      const delta = (ev.clientX - startX) / currentScale;
      finalW = Math.round(Math.max(minW, Math.min(maxW, startW + delta)));
      guide.style.left = `${Math.max(bounds.left + minW * currentScale, headerLeft + finalW * currentScale)}px`;
    };

    const up = () => {
      guide.remove();
      el.style.background = '';
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      setColumnWidth(effectiveKind, colId, finalW);
    };

    resizeCleanup.current = up;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };

  const resizeColumnWithKeyboard = (event: KeyboardEvent, id: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const width = event.key === 'Home' ? DEFAULT_COL_SIZE[id] ?? 120
      : widthFor(id) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10);
    setColumnWidth(effectiveKind, id, Math.max(id === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, (tableRef.current?.clientWidth ?? MAX_COL * uiFactor(uiScale)) / uiFactor(uiScale), width)));
  };

  const resetColumn = (id: string) => { setColumnWidth(effectiveKind, id, DEFAULT_COL_SIZE[id] ?? 120); fitColumns(true); };
  return { resetColumn, widthFor, moveColumn, resetWidths, startColResize, resizeColumnWithKeyboard };
}
