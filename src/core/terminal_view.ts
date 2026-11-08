import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { loadTerminalFonts, terminalFontStack } from './terminal_appearance';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export type TerminalView = ReturnType<typeof createTerminalView>;
type Appearance = {
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalScrollback: number;
  terminalBackground?: string;
};

/** Every PTY uses the same cell geometry, Unicode widths and renderer lifecycle. */
export function createTerminalView(host: HTMLElement, appearance: Appearance, onResize?: (cols: number, rows: number) => void) {
  const bg = appearance.terminalBackground || '#1e1f22';
  const terminal = new Terminal({
    fontFamily: terminalFontStack(appearance.terminalFontFamily), fontSize: appearance.terminalFontSize,
    lineHeight: appearance.terminalLineHeight, scrollback: appearance.terminalScrollback,
    cursorBlink: true, disableStdin: true, allowProposedApi: true,
    customGlyphs: true, rescaleOverlappingGlyphs: true,
    theme: {
      background: bg, foreground: '#dfe1e5', cursor: '#82aaff', selectionBackground: '#3574f055',
      black: bg, red: '#e05555', green: '#59a869', yellow: '#e5b742', blue: '#3574f0',
      magenta: '#b392f0', cyan: '#39c5bb', white: '#dfe1e5',
      brightBlack: '#6f737a', brightRed: '#ff8585', brightGreen: '#8acb91', brightYellow: '#f5d78e',
      brightBlue: '#82aaff', brightMagenta: '#d1b1ff', brightCyan: '#75ded5', brightWhite: '#ffffff',
    },
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const addon = new FitAddon(); terminal.loadAddon(addon);
  const search = new SearchAddon(); terminal.loadAddon(search);

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.key === 'Tab' && event.type === 'keydown') {
      // Keep focus inside xterm for terminal completion without webview tab traversal
      event.stopPropagation();
      return true;
    }
    return true;
  });

  host.dataset.terminalRenderer = 'dom';
  let preferredLineHeight = appearance.terminalLineHeight;
  let disposed = false;
  let frame = 0;
  const fit = () => {
    if (disposed || !terminal.element || !host.clientWidth || !host.clientHeight || !host.getClientRects().length) return;
    // Public same-size resize also remeasures terminals first opened while hidden.
    terminal.resize(terminal.cols, terminal.rows);
    const size = addon.proposeDimensions();
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
    const cols = Math.max(2, Math.min(1000, size.cols));
    const rows = Math.max(1, Math.min(1000, size.rows));
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
    onResize?.(cols, rows);
  };
  const updateLineHeight = () => {
    // Text-based box glyphs cannot bridge added leading in the DOM renderer.
    terminal.options.lineHeight = host.dataset.terminalRenderer === 'dom' && terminal.buffer.active.type === 'alternate' ? 1 : preferredLineHeight;
    fit(); scheduleFit();
  };
  terminal.buffer.onBufferChange(updateLineHeight);
  const applyAppearance = (next: Appearance) => {
    preferredLineHeight = next.terminalLineHeight;
    const nextBg = next.terminalBackground || '#1e1f22';
    terminal.options = {
      ...terminal.options,
      fontFamily: terminalFontStack(next.terminalFontFamily),
      fontSize: next.terminalFontSize,
      scrollback: next.terminalScrollback,
      theme: {
        ...terminal.options.theme,
        background: nextBg,
        black: nextBg,
      },
    };
    updateLineHeight(); terminal.clearTextureAtlas();
  };
  const scheduleFit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  const observer = new ResizeObserver(scheduleFit); observer.observe(host);
  window.addEventListener('resize', scheduleFit);
  fit();
  const ready = loadTerminalFonts(appearance.terminalFontFamily, appearance.terminalFontSize)
    .catch(() => {}).then(() => {
      if (disposed) return;
      // Cell metrics must be measured after the chosen text/symbol faces finish loading.
      terminal.open(host);
      // WebKitGTK + NVIDIA can accept WebGL2 yet present an empty terminal canvas.
      // Use its text renderer; do not change the application's graphics backend.
      const linuxWebKit = /Linux/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
      let webgl: WebglAddon | undefined;
      try {
        if (linuxWebKit) { updateLineHeight(); return; }
        const renderer = webgl = new WebglAddon();
        renderer.onContextLoss(() => { renderer.dispose(); host.dataset.terminalRenderer = 'dom'; updateLineHeight(); });
        terminal.loadAddon(renderer);
        host.dataset.terminalRenderer = 'webgl';
      } catch {
        // WebKit/remote desktops may lack WebGL2. Keep the same PTY and text buffer.
        webgl?.dispose();
      }
      fit(); scheduleFit();
    });
  return { terminal, fit, ready, search, applyAppearance, dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect(); window.removeEventListener('resize', scheduleFit);
    cancelAnimationFrame(frame); terminal.dispose();
  } };
}
