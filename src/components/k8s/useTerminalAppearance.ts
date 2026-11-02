import { useEffect, type RefObject } from 'react';
import type { TerminalView } from '../../core/terminal_view';
import { useUiStore } from '../../state/ui_store';
import { loadTerminalFonts } from '../../core/terminal_appearance';

/** Changing appearance never recreates a terminal or its PTY connection. */
export function useTerminalAppearance(terminal: RefObject<TerminalView | null>, refit: () => void, visible: boolean, generation?: string) {
  const size = useUiStore(state => state.terminalFontSize);
  const family = useUiStore(state => state.terminalFontFamily);
  const lineHeight = useUiStore(state => state.terminalLineHeight);
  const scrollback = useUiStore(state => state.terminalScrollback);
  useEffect(() => {
    let cancelled = false;
    const view = terminal.current;
    if (!view) return;
    const term = view.terminal;
    const apply = () => {
      if (cancelled || terminal.current !== view) return;
      view.applyAppearance({ terminalFontFamily: family, terminalFontSize: size, terminalLineHeight: lineHeight, terminalScrollback: scrollback });
      if (visible) refit();
      term.refresh(0, Math.max(0, term.rows - 1));
    };
    void loadTerminalFonts(family, size).then(apply, apply);
    return () => { cancelled = true; };
    // refit reads current refs, not transport configuration. Fonts never restart transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, size, family, lineHeight, scrollback, visible, generation]);
}
