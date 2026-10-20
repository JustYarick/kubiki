# Terminal fonts, column resizing and port forwarding

## Terminal typography

Settings → Appearance → Terminal typeface:

- Select the bundled JetBrains Mono preset, System monospace, a common Nerd Font preset,
  or enter the installed font's family name / fallback list and press Apply. For example:
  `'MesloLGS NF', monospace`. Presets name installed fonts; they do not install these fonts.
- Font size and line height are independent of interface scale. Preview includes text,
  Cyrillic, box drawing, Powerline and Nerd icons. Preferences persist locally.
- Symbols Only Mono from Nerd Fonts v3.4.0 is bundled as `Kubiki Nerd Symbols` and used as
  fallback after the user's primary face. No CDN or account access is required. Upstream
  MIT license is included in `public/licenses`; source/hash are in the font asset README.
- Both live (host/Pod/Node) and demo xterm renderers use the same stack. Font loading
  precedes initial live PTY grid measurement; changing typography refits/redraws the
  existing xterm and sends resize, without restarting transport or losing scrollback.
- Local host terminal already uses a real PTY, `$SHELL` / available shell discovery,
  user's home, `-l -i` on Unix, `TERM=xterm-256color`, `COLORTERM=truecolor`. zsh reads its
  normal startup files. Remote shells execute in the chosen Pod/container or Node helper.
  A PC's external terminal emulator and its per-app font preferences are separate; Kubiki
  does not embed that process or automatically import its theme/configuration.

Font-specific / legacy private-use symbols may require the theme's original installed
font. Fallback cannot replace every private glyph from every unrelated font.

References: [xterm options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/),
[xterm font loading](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-web-fonts/README.md),
[Nerd Fonts symbols](https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly).

## Resource table sizing

The fixed-layout resource table uses the sum of explicit column widths, not `width:100%`
with redistributed surplus. Resizing Name, row numbers, or any other column preserves
all other column widths. Width preferences remain per kind/column ID. A narrow pane has
local horizontal scroll; the application frame does not grow to the table's content width.
Pointer capture is bounded by the visible pane edge, shared min/max sizes apply to pointer
and keyboard, and a blue guide shows the effective edge. Cancellation/unmount removes it.
When total width is less than the pane, the remaining area stays blank instead of silently
stretching every column. This is intentional, so subsequent dragging is predictable.

## Real port forwarding (desktop)

Open a Pod/Service → Ports, or its context menu → Port-forward. The bottom Ports panel
also has Add Tunnel: a bounded name/namespace picker over loaded Pods and Services.

1. Choose a declared TCP port or enter a numeric port. For Service this means `spec.ports[].port`;
   the backend resolves its numeric/named `targetPort` on a selected Running Pod.
2. Set a local port, or leave it empty / 0 for an OS-assigned free port.
3. Start. The panel displays the actual returned `127.0.0.1:port`, selected Pod/port,
   context/namespace, traffic counters, uptime and connection errors. Stop closes the
   listener and its child connections. Optional HTTP opening occurs only after success.

UI → Tauri commands → kube-rs `PortForwardManager`. No kubectl subprocess is required.
Native commands are `start_port_forward`, `list_port_forwards`, `stop_port_forward`,
`stop_port_forwards`. Browser snapshots explicitly explain that live transport requires
Desktop. Demo sessions remain simulated and never claim to open a real listener.

Backend behavior:

- Numeric TCP ports 1–65535; loopback IPv4 bind only. Port conflicts are returned, not
  replaced by a random unbound number. Auto-port uses a real listener bound to port 0.
- Pod and Service UID/context/namespace identity is pinned. Service selects via its
  selector, preferring Ready Running Pods, then deterministic names. Named ports can
  resolve on regular or restartable init/sidecar containers. UDP, ExternalName/selectorless
  Services, missing named ports and no Running candidates return explicit failures.
- API/upgrade/RBAC checks precede Active. Every connection rechecks resource/Pod UID
  before and after upgrade. Pod replacement stops that connection with an error; no
  automatic switch to a different Pod. Restart the tunnel to select a new target.
- Sessions belong to the native window, with 16/window and 64 total maximum, and at most
  32 child connections/tunnel. Startup and upgrade have bounded timeouts. Pending starts
  can be cancelled; late registrations are stopped again. Window destruction, pagehide
  and context reset clean up tunnels. Owner boundaries apply to list and stop.
- JoinSet owns connection tasks; guards explicitly abort kube-rs background port forwards
  on cancellation/drop. Traffic counts actual successfully copied bytes; initial/runtime
  errors are retained. UI polls native status every 2 seconds and avoids applying stale
  snapshots over newly created or stopped sessions.

First implementation limitations: TCP only; loopback IPv4; no persistent/reconnect
configuration, HTTPS inference or automatic Pod reselection. Initial upgrade readiness
proves an accepted API stream, not application-level HTTP health. A listener with a failed
individual connection remains available for another attempt and shows its last error.
Closing the Ports tab hides its view; Stop/context change/window close ends the tunnel.

Reference: [Kubernetes port-forward semantics](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/).

## Verification

Unit tests cover font normalization/reset, IPC cancellation/late starts, RBAC and stale
status merging. Rust integration tests use a mock Kubernetes HTTP/WebSocket server with
real local TCP sockets: Pod/Service transfer, targetPort, byte counters, recreation,
permission failures, bind conflicts, cancellation and child cleanup. Browser tests use
the real Tauri JS adapter with native command mocks, plus browser transport refusal,
font/scrollback persistence and geometric column resize assertions.

This is not a manual native-WebKit or real-cluster application traffic acceptance run.
Tests do not mutate user cluster resources or create Node helper Pods.
