# Terminal rendering

OpenCode, local shells and Pod/Node shells share `src/core/terminal_view.ts`.
The shell/program runs in a real PTY. xterm.js renders its output inside Kubiki;
it is separate from the selected shell. The local shell defaults to `$SHELL`
(on Windows, the available system shell) and reads its normal startup files.
A different terminal application's fonts and window cannot be imported as a shell.
External-terminal launching would be a separate window/transport integration.

## Appearance and layout

Use **Settings → Terminal** for font family, size, line height and scrollback.
These settings update existing terminals without restarting their processes.
Log viewers share the font preferences and remeasure their virtual rows after a
change. Existing log controls, filtering and container selection are retained.

The shared renderer waits for text and bundled Nerd symbol faces before opening
xterm and measuring cells. Typography changes clear the glyph atlas and refit.
Padding lives outside the measured host, so rows and columns sent to the PTY fit
inside the pane. ResizeObserver and window resize schedule one fit per animation
frame; hidden panes never reduce the PTY to a tiny placeholder size.

Unicode 11 widths are enabled before parsing output. WebGL draws custom box,
block and Powerline glyphs, keeping TUI borders continuous with line spacing.
When WebGL2 is unavailable or its context is lost, the same buffer and connection
continue through the DOM renderer. Linux WebKitGTK uses DOM directly. No global
application graphics override is introduced.

In DOM rendering, alternate-screen TUIs use line height 1.0 so font box/block glyphs
stay connected. Returning to the shell restores the user's preferred spacing,
including changes made while the TUI was open. Native font/layout updates receive
a second fit on the next animation frame after the renderer updates its cell metrics.
This does not claim full Unicode grapheme/emoji-sequence support.

These capabilities use the official xterm
[Unicode addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11),
[WebGL addon and context-loss API](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-webgl/README.md)
and [custom glyph options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/).

## Terminal environment and startup

Local PTYs and OpenCode advertise `TERM=xterm-256color`, `COLORTERM=truecolor`
and `TERM_PROGRAM=kubiki`. Parent Ghostty/Kitty/tmux/window hints and fixed
`COLUMNS`/`LINES` are removed so a TUI does not assume another emulator's features.
Shell configuration and ordinary inherited environment variables remain available.
On Unix, external agents (OpenCode, Codex and Claude Code) start through the
default shell in interactive login mode before replacing it with the CLI (`cd -- "$1" && shift && exec "$@"`). This
loads `.zshrc` for zsh, including exported provider tokens, while restoring Kubiki's workspace directory. Startup output stays
in the PTY; Kubiki does not read or persist the token. CLI arguments are passed
as positional arguments, including prompts containing shell punctuation.
External agents can also be configured to launch in the system default terminal emulator (e.g. Ghostty, Kitty, Alacritty, WezTerm, `xdg-terminal-exec`) via `src-tauri/src/system_terminal.rs` using direct argv without shell string interpolation.
Pod/Node shells set the same terminal capabilities with shell builtins before
starting the selected interactive shell; minimal images need no extra env binary.

Terminal device/color queries use the same input stream as keyboard data. After
Started, their responses are buffered until the native connection is acknowledged,
then flushed. Stop/exit discards pending data; it cannot reach a later session.
The OpenCode intent-delivery and permission rules are unchanged.

## Pod Shell and Attach

**Shell** creates a separate exec process. **Attach** connects to the container's
main process (PID 1), with backend confirmation and a persistent notice in the
pane. Ctrl+C and `exit` in Attach can stop that process and trigger the Pod's
container restart policy. Use Shell for independent scripts. To leave Attach,
use **Disconnect attach** or **Ctrl+P, Ctrl+Q**; these detach keys are consumed
locally. Disconnecting closes the session without sending an interrupt or a
Kubernetes restart/delete operation. Shell commands themselves can still affect
the workload, and closing an exec connection does not guarantee background jobs
have stopped.

## Verification

`terminal_rendering.spec.ts` checks grid bounds, Unicode widths, renderer fallback,
context loss, hidden panes and font readiness. AI/exec scenarios cover early device
queries, resizing, appearance changes without reconnecting, and retained logs.
Core tests cover real host PTYs and removal of inherited terminal capabilities.
They also verify interactive zsh startup with a synthetic `.zshrc` and literal
CLI arguments. Browser exec coverage checks Attach's notice and detach keys.
The opt-in `terminal_smoke` example checks remote TTY resize, advertised capabilities,
stdin/stdout and exit against an explicitly selected disposable Pod.
