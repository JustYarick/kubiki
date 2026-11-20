import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { cx } from '../../core/utils/cx';
import './ui.css';

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  width?: string;
  headerClassName?: string;
  cellClassName?: string;
  /** Hide lower-priority columns automatically when the container is narrow. */
  hideBelow?: 'sm' | 'md';
  cell: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  variant?: 'default' | 'grid' | 'detail' | 'compact';
  stickyHeader?: boolean;
  ariaLabel?: string;
  caption?: ReactNode;
  empty?: ReactNode;
  className?: string;
  tableClassName?: string;
  rowAriaLabel?: (row: T, index: number) => string | undefined;
  rowClassName?: (row: T, index: number) => string | undefined;
  isRowSelected?: (row: T, index: number) => boolean;
  rowTabIndex?: number;
  onRowClick?: (row: T, index: number, event: MouseEvent<HTMLTableRowElement>) => void;
  onRowContextMenu?: (row: T, index: number, event: MouseEvent<HTMLTableRowElement>) => void;
  onRowKeyDown?: (row: T, index: number, event: KeyboardEvent<HTMLTableRowElement>) => void;
}

/**
 * Reusable, container-aware data table for secondary tables, histories,
 * detail panels, and dock views. Preserves scroll containers, keyboard
 * focusability, and narrow-pane responsive column hiding.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  variant = 'default',
  stickyHeader = false,
  ariaLabel,
  caption,
  empty,
  className,
  tableClassName,
  rowAriaLabel,
  rowClassName,
  isRowSelected,
  rowTabIndex,
  onRowClick,
  onRowContextMenu,
  onRowKeyDown,
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return empty ? <>{empty}</> : null;
  }

  const baseTableClass =
    variant === 'grid'
      ? 'datagrip-grid w-full'
      : variant === 'detail'
        ? 'details-table'
        : 'ui-data-table';

  const wrapClass =
    variant === 'detail'
      ? cx('details-table-scroll ui-data-table-wrap', className)
      : cx('ui-data-table-wrap kubiki-scrollbar', className);

  const interactive = !!(onRowClick || onRowKeyDown);

  return (
    <div className={wrapClass}>
      <table
        aria-label={ariaLabel}
        data-variant={variant}
        data-sticky={stickyHeader ? 'true' : undefined}
        className={cx(baseTableClass, tableClassName)}
      >
        {caption && <caption className="details-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                data-align={col.align}
                data-hide-below={col.hideBelow}
                style={col.width ? { width: col.width } : undefined}
                className={cx(col.align === 'right' && 'text-right', col.headerClassName)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = isRowSelected?.(row, index);
            return (
              <tr
                key={rowKey(row, index)}
                tabIndex={rowTabIndex ?? (interactive ? 0 : undefined)}
                aria-label={rowAriaLabel?.(row, index)}
                aria-selected={selected !== undefined ? selected : undefined}
                data-interactive={interactive ? 'true' : undefined}
                className={rowClassName?.(row, index)}
                onClick={onRowClick ? (event) => onRowClick(row, index, event) : undefined}
                onContextMenu={onRowContextMenu ? (event) => onRowContextMenu(row, index, event) : undefined}
                onKeyDown={onRowKeyDown ? (event) => onRowKeyDown(row, index, event) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.id}
                    data-align={col.align}
                    data-hide-below={col.hideBelow}
                    className={cx(col.mono && 'font-mono', col.align === 'right' && 'text-right', col.cellClassName)}
                  >
                    {col.cell(row, index)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
