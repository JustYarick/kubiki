import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as UI from '../../src/components/ui';

describe('Kubiki shared UI/UX module (src/components/ui)', () => {
  it('re-exports every core interactive and layout primitive from the module barrel', () => {
    for (const symbol of [
      'Button',
      'IconButton',
      'Tooltip',
      'Input',
      'SearchInput',
      'Textarea',
      'Select',
      'Checkbox',
      'CheckboxRow',
      'Badge',
      'CountPill',
      'DataTable',
      'Field',
      'FieldGroup',
      'SectionCard',
      'EmptyState',
      'KeyValueList',
      'Modal',
      'Popover',
      'MenuList',
      'FixedMenu',
      'OverflowTooltip',
      'ResponsiveToolbar',
      'NamespaceSelect',
      'SearchableSelect',
      'CodeEditor',
      'ResourceLoading',
      'FloatingIsland',
      'DeliverySummary',
      'ErrorBoundary',
      'Toasts',
    ] as const) {
      expect(UI[symbol], `missing UI export: ${symbol}`).toBeDefined();
    }
  });

  it('disables spelling autocorrection on Input and SearchInput by default and supports flexible variants', () => {
    const inputHtml = renderToStaticMarkup(
      React.createElement(UI.Input, {
        size: 'sm',
        variant: 'subtle',
        mono: true,
        invalid: true,
        value: 'qdrant-0',
        onChange: () => {},
        'aria-label': 'Pod filter',
      }),
    );
    expect(inputHtml).toContain('autoCorrect="off"');
    expect(inputHtml).toContain('autoCapitalize="none"');
    expect(inputHtml).toContain('spellCheck="false"');
    expect(inputHtml).toContain('aria-invalid="true"');
    expect(inputHtml).toContain('font-mono');

    const searchHtml = renderToStaticMarkup(
      React.createElement(UI.SearchInput, {
        value: '[invalid',
        onChange: () => {},
        isRegex: true,
        onToggleRegex: () => {},
        placeholder: 'Filter resources…',
      }),
    );
    expect(searchHtml).toContain('autoCorrect="off"');
    expect(searchHtml).toContain('Invalid regex:');
    expect(searchHtml).toContain('aria-pressed="true"');
  });

  it('renders adaptive DataTable, Badge, SectionCard, Field, KeyValueList and EmptyState', () => {
    const tableHtml = renderToStaticMarkup(
      React.createElement(UI.DataTable<{ id: string; name: string; count: number }>, {
        ariaLabel: 'Sample table',
        stickyHeader: true,
        rows: [{ id: '1', name: 'worker-1', count: 12 }],
        rowKey: (row) => row.id,
        columns: [
          { id: 'name', header: 'Name', mono: true, cell: (row) => row.name },
          { id: 'count', header: 'Pods', align: 'right', hideBelow: 'sm', cell: (row) => row.count },
        ],
      }),
    );
    expect(tableHtml).toContain('aria-label="Sample table"');
    expect(tableHtml).toContain('data-sticky="true"');
    expect(tableHtml).toContain('data-hide-below="sm"');
    expect(tableHtml).toContain('worker-1');

    const emptyTableHtml = renderToStaticMarkup(
      React.createElement(UI.DataTable, {
        rows: [],
        rowKey: (_, idx) => idx,
        columns: [{ id: 'a', header: 'A', cell: () => null }],
        empty: React.createElement(UI.EmptyState, { compact: true, title: 'No items' }),
      }),
    );
    expect(emptyTableHtml).toContain('No items');
    expect(emptyTableHtml).not.toContain('<table');

    const cardHtml = renderToStaticMarkup(
      React.createElement(
        UI.SectionCard,
        {
          title: 'Scheduling',
          subtitle: '2 rules',
          actions: React.createElement(UI.CountPill, { count: 2, tone: 'info' }),
        },
        React.createElement(
          UI.FieldGroup,
          null,
          React.createElement(
            UI.Field,
            { label: 'Node', hint: 'Target node', horizontal: true },
            React.createElement(UI.Badge, { tone: 'ok', dot: true }, 'worker-1'),
          ),
        ),
        React.createElement(UI.KeyValueList, {
          items: [{ label: 'QoS', value: 'Guaranteed', mono: true }],
        }),
      ),
    );
    expect(cardHtml).toContain('ui-section-card');
    expect(cardHtml).toContain('ui-field-group');
    expect(cardHtml).toContain('data-tone="ok"');
    expect(cardHtml).toContain('ui-badge-dot');
    expect(cardHtml).toContain('ui-kv-list');
    expect(cardHtml).toContain('Guaranteed');
  });

  it('keeps migrated views free of ad-hoc raw <input> tags', () => {
    const migrated = [
      'src/components/layout/Sidebar.tsx',
      'src/components/ui/NamespaceSelect.tsx',
      'src/components/ui/SearchableSelect.tsx',
      'src/components/k8s/ColumnFilterPopup.tsx',
      'src/views/HelmView.tsx',
      'src/views/GitOpsDashboard.tsx',
      'src/components/k8s/details/PodEnvironmentTab.tsx',
      'src/components/k8s/details/blocks/ConfigMapDataBlock.tsx',
      'src/components/dialogs/HelmActionDialog.tsx',
      'src/components/TerminalFontSettings.tsx',
      'src/components/k8s/LiveTerminalPane.tsx',
    ];
    for (const rel of migrated) {
      const content = readFileSync(resolve(process.cwd(), rel), 'utf8');
      expect(content, `${rel} should use Input/SearchInput/Checkbox from components/ui`).not.toMatch(/<input\b/);
    }
  });
});
