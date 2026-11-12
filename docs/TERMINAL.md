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
Pod/Node shells set the same terminal capabilities with shell builtins before
starting the selected interactive shell; minimal images need no extra env binary.

Terminal device/color queries use the same input stream as keyboard data. After
Started, their responses are buffered until the native connection is acknowledged,
then flushed. Stop/exit discards pending data; it cannot reach a later session.
The OpenCode intent-delivery and permission rules are unchanged.

## Verification

`terminal_rendering.spec.ts` checks grid bounds, Unicode widths, renderer fallback,
context loss, hidden panes and font readiness. AI/exec scenarios cover early device
queries, resizing, appearance changes without reconnecting, and retained logs.
Core tests cover real host PTYs and removal of inherited terminal capabilities.
The opt-in `terminal_smoke` example checks remote TTY resize, advertised capabilities,
stdin/stdout and exit against an explicitly selected disposable Pod.
