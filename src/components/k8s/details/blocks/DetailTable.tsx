import type { ReactNode } from 'react';
import { DataTable, type DataTableColumn } from '../../../ui/DataTable';

export interface DetailTableProps {
  columns: string[];
  rows: ReactNode[][];
  /** Rendered when the object has no entries; hides the table completely. */
  empty?: ReactNode;
  caption?: string;
}

/**
 * Dense read-only table used by every details panel.
 * Backed by the shared `DataTable` primitive (`variant="detail"`).
 */
export function DetailTable({ columns, rows, empty, caption }: DetailTableProps) {
  const tableColumns: DataTableColumn<ReactNode[]>[] = columns.map((column, cellIndex) => ({
    id: `${cellIndex}-${column}`,
    header: column,
    cell: (row) => row[cellIndex],
  }));

  return (
    <DataTable
      variant="detail"
      columns={tableColumns}
      rows={rows}
      rowKey={(_, index) => index}
      caption={caption}
      empty={empty ? <p className="details-caption">{empty}</p> : undefined}
    />
  );
}
