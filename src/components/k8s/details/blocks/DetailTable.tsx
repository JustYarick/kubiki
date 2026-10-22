import type { ReactNode } from 'react';

export interface DetailTableProps {
  columns: string[];
  rows: ReactNode[][];
  /** Rendered when the object has no entries; hides the table completely. */
  empty?: ReactNode;
  caption?: string;
}

/**
 * Dense read-only table used by every details panel.
 *
 * Keeps one visual language for tabular data: the same header, row height and
 * scroll container everywhere, instead of per-panel ad-hoc markup.
 */
export function DetailTable({ columns, rows, empty, caption }: DetailTableProps) {
  if (!rows.length) {
    return empty ? <p className="details-caption">{empty}</p> : null;
  }
  return (
    <div className="details-table-scroll">
      <table className="details-table">
        {caption && <caption className="details-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map(column => <th key={column} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
