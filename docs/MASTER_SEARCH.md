# Master search and resource performance

Open master search with `Ctrl+K` / `⌘K` or Search Everywhere. It reads accessible objects in the current cluster independently of which resource tables have been opened. Built-in kinds, discovered custom resources and Helm releases are included. Reads run on demand with bounded low-priority concurrency, reuse active live watch snapshots, skip collections whose metadata count in scope is zero (`getResourceCounts`), batch-probe custom resources (`get_custom_search_inventory` with `limit=1` metadata checks before listing non-empty CRDs), prioritize core workloads/resources ahead of high-volume collections (`Event`, `EndpointSlice`, `Endpoints`, `Lease`, `HelmRelease`), use metadata-only or stripped search projections in native mode (hydrating full objects on selection), and preserve interrupted scan progress across reopens. A 3-minute in-memory inventory cache can be refreshed using the refresh button.

The default scope is all namespaces. Select **Selected** to use the main namespace selector instead. The object/command selector keeps normal command navigation available. Search results open a detail tab pinned to the object's namespace; the main list filter does not change. The scope pin also applies when reopening an existing result tab.

## Query syntax

Plain search supports multiple terms and fuzzy matching. Prefix a term with a field to filter that field; combine filters to narrow results. Prefix a term with `-` to exclude it. Use quotes for phrases.

```text
kind:Pod ns:production label:app=web -status:Failed
image:registry.example/web node:worker-a
annotation:owner=platform name:backend
```

Native search projections retain container waiting/termination states and desired replica counts so status filters also work before a resource table has been opened.

Supported fields: `name`, `kind` (`type`), `ns` (`namespace`), `status`, `label` (`labels`), `annotation` (`annotations`), `image`, `node`, `api`, `uid`.

Use `.*` or `Alt+R` for regex; **Aa** controls case sensitivity. Expressions are applied to individual searchable fields, so name anchors behave as expected. A regex without field prefixes is treated as one expression, including any spaces or alternation. With field prefixes, use one expression per term and quote expressions that contain spaces.

```text
name:^web-(api|jobs)-\d+$ kind:^Pod$
ns:^(production|staging)$ -status:Failed
```

Search indexes metadata and selected diagnostic fields. Secret `data`/`stringData`, container environment values and the contents of the last-applied manifest annotation are excluded. It does not search arbitrary YAML bodies. Regex compilation and evaluation run in a Web Worker (reused across keystrokes and recreated cleanly on the computation deadline), so pathological expressions cannot block the renderer. Invalid or slow expressions show an actionable error.

Unavailable collections are listed as partial coverage, rather than silently claiming a complete search. Results are paged in the palette, with a count of all matches; the worker returns up to 1,000 results and larger result sets require narrower filters. Search results are observations, not a guarantee that an object still exists when opened; detail views keep the normal UID/context checks and live refresh.

## Node details

Node details include independently sampled CPU and memory histories, usage relative to allocatable resources, a fixed-scale option, a 5/15/30-minute range, pause/resume and manual refresh. The Metrics API source timestamp and CPU averaging window are shown. Node metrics are cluster-scoped and do not change with a Pod namespace filter. Overview and node views share the same read subscription; per-node history uses actual source timestamps and rejects duplicates/stale observations.

Scheduling state, provider ID, Pod CIDRs, region/zone, machine/system/boot identity, cached image-group counts and volume information accompany the existing capacity, runtime, addresses, taints, conditions and Pod details. Node Pod inventory covers all namespaces; permission failures are displayed as incomplete data.

Opening a Node can widen the shared Pod watch. Existing rows that match the new
scope and their navigation history remain available while it initializes. The
table still follows the namespace selector; retained rows do not establish a
complete snapshot of the wider scope. The same rule applies to other inspectors
and split views that expand resource demand, while direct forward references of an
inspected object (such as a Pod's `Node`, owner chain, `ServiceAccount`, `PVC`, `ConfigMap`,
and `Secret` metadata, or object-scoped Events) are prefetched via targeted single-object reads
into the detail cache without opening full collection watches.

Overview fetches warning/non-normal Events with a server-side `type!=Normal` field selector and expands to an unfiltered Event watch when a specific object or Events pane is inspected. Metadata-only reads carry an explicit projection marker; opening Pod Environment upgrades cached Secret metadata to a full read, including for an empty Secret. Native Pod details poll single-Pod metrics directly (`get_pod_metric`) instead of loading all namespace Pod metrics.

Metrics Server supplies CPU and memory, not disk/network performance rates or historical data from before the application collected it. Missing or denied usage is shown as unavailable. Unknown capacities and system fields remain unknown.

## Helm release diagnostics

Release Overview shows Helm's latest operation description for failed/pending
operations. Failed and pending releases load revision manifests and hooks for
comparison with observed objects. Details retain workload reads in the release
namespace, independently of the table's namespace selection.

**Release events** reads events in the release namespace and namespaces of its
observed objects. It correlates events to observed release objects, hooks and
loaded descendants (including Job Pods) by resource identity and owner UID.
The newest 100 matching events are shown with reason, message, time and count;
**Refresh release events** reads them again. Read failures are shown per
namespace. Unloaded objects, deleted hooks and expired events can leave gaps;
an empty event list does not establish release health.

## Pod details and shared charts

Pod details include CPU and memory histories, requests and effective limits, usage relative to the limit, and individual container usage. Range, fixed scale, pause/resume and refresh work as in node details. Reads share the namespace Metrics API subscription. Only viewed Pods retain history, limited to 32 identities and 120 observations per Pod. Context, namespace and Pod UID separate histories; source observations predating Pod creation are rejected. Missing, stale or denied metrics are identified in the interface.

Performance contains Pod totals only. A single container list follows it, ordered by application, native sidecar, init and ephemeral roles. Each row shows its role, state, restart count and CPU/RAM usage alongside Logs/Shell actions; unavailable usage is a dash, and retained values after metric errors are labelled as the last sample. Expanding a row exposes its image, detailed state, resources, ports, probes, environment and mounts. Native sidecar definitions and states are resolved from the init arrays by name. The charts and rows use one snapshot and pause control, avoiding duplicate reads and duplicate container lists.

Overview, node and Pod charts display a single measurement as a horizontal preview, explicitly labelled as the first measurement. It remains one sample in the data and tooltip. Once a second measurement arrives, the line joins the real observations, including across pauses or missing measurements. The time axis preserves the elapsed interval. These connecting lines do not add synthetic observations or zeroes; tooltips and sample counts use actual measurements only.

The shared SVG chart measures its rendered area with ResizeObserver and uses the same coordinate scale on both axes. Lines retain their stroke width and markers remain circular on narrow panes and ultrawide monitors. Pointer selection accounts for the chart's plot padding; keyboard arrows and Home/End inspect the same actual observations.

Pod details display configured CPU and RAM requests before the first metrics sample. Pending Pod summaries show assignment, any nominated node and the scheduling condition message. Resource filters and master search disable automatic spelling corrections for resource names.

The desktop Pod informer requests its initial collection in one LIST per namespace scope, then watches changes from the returned resource version. Opening a Pod table does not read individual Pods. Kubernetes returns full Pod objects for the custom per-container indicators; server Table rows omit individual container states. When the collection already covers the sidebar namespace scope, the sidebar uses the snapshot size and skips its separate count probe during startup. Multiple individually selected namespaces retain separate requests for namespace-scoped RBAC.
