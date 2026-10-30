import React from 'react';

export interface RightActivityBarItem {
  id: string;
  title: string;
  icon: React.ComponentType<{ size?: string | number; className?: string }>;
  active?: boolean;
  onClick?: () => void;
}

export const RightActivityBar: React.FC<{
  items?: RightActivityBarItem[];
}> = ({ items = [] }) => {
  // If no items are registered for the right activity bar, do not occupy space
  if (!items.length) {
    return null;
  }

  return (
    <aside
      className="w-10 bg-[var(--bg-secondary)] border-l border-[var(--border-default)] flex flex-col items-center py-2 shrink-0 select-none z-20"
      aria-label="Secondary Activity Bar"
    >
      <div className="flex flex-col items-center gap-1 w-full">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={item.onClick}
            aria-label={item.title}
            aria-pressed={item.active}
            className={`relative w-8 h-8 flex items-center justify-center rounded-[calc(4px*var(--ui-factor))] transition-all ${
              item.active
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <item.icon size="calc(16px * var(--ui-factor))" />
            {item.active && (
              <span className="absolute right-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-l" />
            )}
          </button>
        ))}
      </div>
    </aside>
  );
};
