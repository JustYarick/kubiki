import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useUiStore } from '../../state/ui_store';
import { uiFactor } from '../../core/appearance';
import { cx } from '../../core/utils/cx';
import './responsive.css';

/** Layout follows the actual pane width and UI scale, including split editors. */
export function ResponsiveToolbar({ identity, children, primaryAction, label, className }: {
  identity: ReactNode; children: ReactNode; primaryAction?: ReactNode; label: string; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const scale = useUiStore(state => state.uiScale);
  const [layout, setLayout] = useState<'wide' | 'compact' | 'narrow'>('narrow');
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth / uiFactor(scale);
      setLayout(width < 360 ? 'narrow' : width < 640 ? 'compact' : 'wide');
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scale]);
  return <div ref={root} role="group" aria-label={label} data-layout={layout} className={cx('responsive-toolbar', className)}>
    <div className="responsive-toolbar-layout">
      <div className="responsive-toolbar-identity">{identity}</div>
      <div className="responsive-toolbar-actions">{children}</div>
      {primaryAction && <div className="responsive-toolbar-primary">{primaryAction}</div>}
    </div>
  </div>;
}
