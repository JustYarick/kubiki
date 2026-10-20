import { expect, it } from 'vitest';
import { DEFAULT_TERMINAL_FONT, normalizeTerminalFont, terminalFontStack, normalizeTerminalLineHeight } from '../../src/core/terminal_appearance';
import { useUiStore } from '../../src/state/ui_store';
it('retains user font lists with an offline Nerd symbols fallback', () => {
  expect(terminalFontStack("'MesloLGS NF', monospace")).toContain("'MesloLGS NF', monospace, 'Kubiki Nerd Symbols'");
  expect(normalizeTerminalFont('  JetBrains Mono  ')).toBe('JetBrains Mono');
  for (const value of [null, {}, '', 'a'.repeat(513), 'font; color:red', 'bad\nfont']) expect(normalizeTerminalFont(value)).toBe(DEFAULT_TERMINAL_FONT);
  expect(terminalFontStack(undefined)).toContain('monospace');
});
it('bounds line height and resets typography along with appearance', () => {
  expect(normalizeTerminalLineHeight(NaN)).toBe(1.2);
  expect(normalizeTerminalLineHeight(5)).toBe(2);
  expect(normalizeTerminalLineHeight(.1)).toBe(1);
  const store = useUiStore.getState();
  store.setTerminalFontFamily('Custom Mono'); store.setTerminalLineHeight(1.45);
  expect(useUiStore.getState()).toMatchObject({ terminalFontFamily: 'Custom Mono', terminalLineHeight: 1.45 });
  store.resetAppearance();
  expect(useUiStore.getState()).toMatchObject({ terminalFontFamily: DEFAULT_TERMINAL_FONT, terminalLineHeight: 1.2 });
});
