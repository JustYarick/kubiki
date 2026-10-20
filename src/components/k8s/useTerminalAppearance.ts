import { useEffect, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useUiStore } from '../../state/ui_store';
import { loadTerminalFonts, terminalFontStack } from '../../core/terminal_appearance';

/** Changing appearance never recreates a terminal or its PTY connection. */
export function useTerminalAppearance(terminal: RefObject<Terminal | null>, refit: () => void, visible: boolean, generation?: string) {
  const size = useUiStore(state => state.terminalFontSize);
  const family = useUiStore(state => state.terminalFontFamily);
  const lineHeight = useUiStore(state => state.terminalLineHeight);
  useEffect(() => {
    let cancelled = false;
    const term = terminal.current;
    if (!term) return;
    const apply = () => {
      if (cancelled || terminal.current !== term) return;
      term.options.fontFamily = terminalFontStack(family);
      term.options.fontSize = size;
      term.options.lineHeight = lineHeight;
      if (visible) refit();
      term.refresh(0, Math.max(0, term.rows - 1));
    };
    void loadTerminalFonts(family, size).then(apply, apply);
    return () => { cancelled = true; };
    // refit reads current refs, not transport configuration. Fonts never restart transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, size, family, lineHeight, visible, generation]);
}
