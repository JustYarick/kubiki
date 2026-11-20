# Shared UI/UX module (`src/components/ui`)

All reusable controls, form inputs, secondary tables, overlays, and adaptive layout primitives live in `src/components/ui/` and are re-exported from [`src/components/ui/index.ts`](../src/components/ui/index.ts).

## Design rules

- **Scale through CSS tokens**: every height, radius, font size, spacing, and icon size uses `--ui-factor` (`--control-h-*`, `--font-size-*`, `--radius-*`, `--space-*`) so UI scaling (80%–200%) stays uniform across panels and popovers.
- **Adapt to container width, not only window width**: layout primitives (`SectionCard`, `FieldGroup`, `Field`, `KeyValueList`, `DataTable`, `ResponsiveToolbar`) use CSS container queries (`container-type: inline-size`) or `ResizeObserver` + `min-w-0` so narrow inspector panes, split views, and small dialogs never cause horizontal overflow.
- **Literal-safe inputs**: `Input` and `SearchInput` disable WebKit/macOS spelling autocorrection (`autoCorrect="off"`, `autoCapitalize="none"`, `spellCheck={false}`) by default so Kubernetes names and filters are never rewritten on focus changes.
- **One primitive per role**: avoid duplicating raw `<input>`, `<select>`, `<input type="checkbox">`, or secondary `<table>` markup in views—import from `src/components/ui` instead.

## Primitives

| Component | Source | Purpose |
| --- | --- | --- |
| `Button`, `IconButton`, `Tooltip` | `Button.tsx` | Primary/secondary/ghost/danger actions (`xs`/`sm`/`md`/`lg`), scaled icon buttons, delayed tooltips. |
| `Input`, `SearchInput`, `Textarea` | `Input.tsx` | Literal-safe text inputs (`xs`/`sm`/`md`/`lg`, `default`/`subtle`/`ghost`, `mono`, `invalid`, `clearable`), regex-capable search boxes, and textareas. |
| `Select` | `Select.tsx` | Native accessible select that pins the active choice to the top (`xs`/`sm`/`md`). |
| `Checkbox`, `CheckboxRow` | `Checkbox.tsx` | Scaled checkbox with first-class `indeterminate` state and truncating row layout. |
| `Badge`, `CountPill` | `Badge.tsx` | Semantic status/count pills (`neutral`, `ok`, `warn`, `danger`, `info`, `accent`). |
| `DataTable` | `DataTable.tsx` | Generic typed table (`default`, `grid`, `detail`, `compact`) with scroll wrapper, sticky headers, empty state, and `hideBelow` responsive column hiding. |
| `Field`, `FieldGroup`, `SectionCard`, `EmptyState`, `KeyValueList` | `LayoutPrimitives.tsx` | Adaptive form fields, auto-fit grids, collapsible/wrapping section cards, empty states, and responsive `<dl>` key-value grids. |
| `Modal`, `Popover`, `MenuList`, `FixedMenu`, `Toasts` | `Modal.tsx`, `Dropdown.tsx`, `Toasts.tsx` | Dialogs, menus, popovers, and notifications. |
| `ResponsiveToolbar`, `NamespaceSelect`, `SearchableSelect`, `OverflowTooltip`, `CodeEditor`, `ResourceLoading`, `FloatingIsland`, `ErrorBoundary` | `src/components/ui/` | Specialized shared workspace controls. |

Primary virtualized Kubernetes inventories (Pods, Workloads, CRDs, Helm Releases) share [`ResourceView`](../src/views/ResourceView.tsx) and `src/components/k8s/table/`.
