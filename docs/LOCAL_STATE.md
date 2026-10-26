# Local application state

UI preferences live in the desktop WebView's local storage on the current device.
Browser development/demo sessions have their own origin storage; another Mac,
computer, browser profile or application origin does not share these preferences.
There is no cloud synchronization. Clearing application/web storage removes them.

| State | Restored after restart |
| --- | --- |
| Last selected kubeconfig context | Yes by default; toggle **Settings → Kubernetes → Reopen last selected cluster**. A removed context falls back to kubeconfig's current context, then the first available context. An unreachable remembered cluster stays selected and offers Reconnect. |
| Namespace scope | Yes, independently for each context, unless remembering namespaces is disabled. |
| Custom kubeconfig location | Session-only: the backend keeps the override in memory. After restart it uses the default kubeconfig location or `KUBECONFIG`. |
| Workspace | Tab identities/order and active tab. Resource snapshots and running terminal processes are not restored from disk. Split layout is session-only. |
| Interface | Scale, fonts, density, sidebar/inspector widths, sidebar expansion and table column visibility/order/widths. Inspector opens on demand; the bottom dock closes on connection. |
| Topology | Rendering preferences and hidden resource kinds. Diagram scope/direction, zoom, dragged positions and arrow bends are session-only. |
| Logs, terminal, YAML editor | Their default preferences. Log contents, terminal output/processes and unsaved YAML text stay in memory and are lost when the app exits. |
| Table search and selection | Session-only; search belongs to its open tab. |
| Port forwards | Default port range/browser preference persists; active tunnels close on exit or cluster change. |
| AI and updates | Selected analysis agent, starting prompt and update preferences persist locally. |

Cluster resource data is loaded again on connection. Context persistence stores
only the context name, not kubeconfig credentials or an API client. Selecting a
cluster does not rewrite kubeconfig's `current-context`.

## Topology rendering

Open **Settings → Topology**. Rendering controls apply to open diagrams and are
saved immediately. The diagram's own settings island contains scope, direction,
relationship depth, arrangement and resource filters.

- **Quality** keeps shadows and follows the individual connection, animation,
  label, minimap and grid choices.
- **Balanced** removes node shadows and follows those same individual choices.
  New installations use static connections by default.
- **Performance** uses straight static connections, compact node contents and no
  shadows, labels, minimap or background grid. Detailed resource information is
  still available in the inspector. Custom effect preferences remain saved and
  return when switching back to Quality/Balanced.
- **Flat** grouping reduces hierarchical layout work; namespace grouping keeps
  the enclosing namespace boxes. Choose this separately from the rendering profile.
- **Live redraw interval** coalesces resource updates before copying them to the
  graph worker. Performance uses at least 3 seconds. A scope change bypasses that
  delay, and the latest pending snapshot is retained during an ongoing build.

The OS reduced-motion preference disables connection animation in every profile.
Changing these controls does not request extra Kubernetes snapshots or watches.
Graph construction and automatic layout remain in workers; node dragging no
longer recalculates the entire graph's structure key on every mouse movement.

For a Mac with slow panning, start with **Performance** and try **Flat** grouping
for large graphs. These controls reduce frontend work; they do not replace the
native WebView engine. Native macOS GPU/frame pacing still requires testing on
the actual machine; Linux/Chromium tests cannot establish its resulting FPS.
