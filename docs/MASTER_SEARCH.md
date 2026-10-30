# Master search and resource performance

Open master search with `Ctrl+K` / `⌘K` or Search Everywhere. It reads accessible objects in the current cluster independently of which resource tables have been opened. Built-in kinds, discovered custom resources and Helm releases are included. Reads run on demand with bounded concurrency and are cancelled when the palette closes or the context changes. A short in-memory cache can be refreshed using the refresh button.

The default scope is all namespaces. Select **Selected** to use the main namespace selector instead. The object/command selector keeps normal command navigation available. Search results open a detail tab pinned to the object's namespace; the main list filter does not change. The scope pin also applies when reopening an existing result tab.

## Query syntax

Plain search supports multiple terms and fuzzy matching. Prefix a term with a field to filter that field; combine filters to narrow results. Prefix a term with `-` to exclude it. Use quotes for phrases.

```text
kind:Pod ns:production label:app=web -status:Failed
image:registry.example/web node:worker-a
annotation:owner=platform name:backend
```

Supported fields: `name`, `kind` (`type`), `ns` (`namespace`), `status`, `label` (`labels`), `annotation` (`annotations`), `image`, `node`, `api`, `uid`.

Use `.*` or `Alt+R` for regex; **Aa** controls case sensitivity. Expressions are applied to individual searchable fields, so name anchors behave as expected. A regex without field prefixes is treated as one expression, including any spaces or alternation. With field prefixes, use one expression per term and quote expressions that contain spaces.

```text
name:^web-(api|jobs)-\d+$ kind:^Pod$
ns:^(production|staging)$ -status:Failed
```

Search indexes metadata and selected diagnostic fields. Secret `data`/`stringData`, container environment values and the contents of the last-applied manifest annotation are excluded. It does not search arbitrary YAML bodies. Regex compilation and evaluation run in a disposable Web Worker with a computation deadline, so pathological expressions cannot block the renderer. Invalid or slow expressions show an actionable error.

Unavailable collections are listed as partial coverage, rather than silently claiming a complete search. Results are paged in the palette, with a count of all matches; the worker returns up to 1,000 results and larger result sets require narrower filters. Search results are observations, not a guarantee that an object still exists when opened; detail views keep the normal UID/context checks and live refresh.

## Node details

Node details include independently sampled CPU and memory histories, usage relative to allocatable resources, a fixed-scale option, a 5/15/30-minute range, pause/resume and manual refresh. The Metrics API source timestamp and CPU averaging window are shown. Node metrics are cluster-scoped and do not change with a Pod namespace filter. Overview and node views share the same read subscription; per-node history uses actual source timestamps and rejects duplicates/stale observations.

Scheduling state, provider ID, Pod CIDRs, region/zone, machine/system/boot identity, cached image-group counts and volume information accompany the existing capacity, runtime, addresses, taints, conditions and Pod details. Node Pod inventory covers all namespaces; permission failures are displayed as incomplete data.

Metrics Server supplies CPU and memory, not disk/network performance rates or historical data from before the application collected it. Missing or denied usage is shown as unavailable. Unknown capacities and system fields remain unknown.
