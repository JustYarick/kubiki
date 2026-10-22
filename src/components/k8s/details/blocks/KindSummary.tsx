import { Fragment, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { DetailsSection } from '../DetailsSection';

export interface SummaryRow {
  label: string;
  value: ReactNode;
  /** Long values are truncated in the grid; the full text stays reachable as a tooltip. */
  title?: string;
}

export interface StatTile {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'info' | 'muted';
  title?: string;
}

export interface KindSummaryProps {
  title: string;
  icon?: LucideIcon;
  rows?: SummaryRow[];
  tiles?: StatTile[];
  actions?: ReactNode;
  /** Rendered under the grid, used for hints and status lines. */
  footer?: ReactNode;
}

/**
 * Shared summary section of every details panel.
 *
 * Panels describe the object in the same order: headline numbers first
 * (stat tiles), then the named properties, then optional context.
 */
export function KindSummary({ title, icon, rows, tiles, actions, footer }: KindSummaryProps) {
  const hasTiles = !!tiles?.length;
  const hasRows = !!rows?.length;
  if (!hasTiles && !hasRows && !footer) return null;
  return (
    <DetailsSection title={title} icon={icon} actions={actions}>
      {hasTiles && (
        <div className="details-stat-grid details-stat-tiles">
          {tiles!.map(tile => (
            <div key={tile.label} className="details-stat-tile" data-tone={tile.tone ?? 'default'}>
              <span className="details-stat-label">{tile.label}</span>
              <span className="details-stat-value" title={tile.title}>{tile.value}</span>
            </div>
          ))}
        </div>
      )}
      {hasRows && (
        <dl className="details-properties" data-detail={hasTiles ? 'after-tiles' : undefined}>
          {rows!.map(row => (
            <Fragment key={row.label}>
              <dt title={row.title}>{row.label}</dt>
              <dd title={row.title}>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {footer}
    </DetailsSection>
  );
}
