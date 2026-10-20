import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE, appearanceValue, applyAppearance, normalizeAppearance, uiFactor } from '../../src/core/appearance';
import { useUiStore } from '../../src/state/ui_store';

beforeEach(() => useUiStore.getState().resetAppearance());
describe('Appearance preferences', () => {
  it('uses a readable default and bounds persisted or imported preferences', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ uiScale: NaN, editorFontSize: Infinity, terminalFontSize: -50 })).toEqual({ uiScale: 110, editorFontSize: 14, terminalFontSize: 10 });
    expect(appearanceValue('uiScale', 900)).toBe(200);
    expect(appearanceValue('uiScale', 0)).toBe(80);
    expect(appearanceValue('editorFontSize', 15.9)).toBe(16);
    expect(uiFactor(100)).toBeCloseTo(13 / 12);
    expect(uiFactor(150) / uiFactor(100)).toBeCloseTo(1.5);
  });
  it('keeps UI scale independent of editor and terminal fonts, and resets only appearance', () => {
    const store = useUiStore.getState();
    store.setSidebarWidth(310); store.setUiScale(150); store.setEditorFontSize(18); store.setTerminalFontSize(20);
    expect(useUiStore.getState()).toMatchObject({ uiScale: 150, editorFontSize: 18, terminalFontSize: 20 });
    store.resetAppearance();
    expect(useUiStore.getState()).toMatchObject({ ...DEFAULT_APPEARANCE, sidebarWidth: 310 });
  });
  it('applies CSS dimensions and font tokens without a bitmap transform or CSS zoom', () => {
    const root = { style: { setProperty: vi.fn() }, dataset: {} };
    applyAppearance(root as unknown as HTMLElement, { uiScale: 150, editorFontSize: 18, terminalFontSize: 20 });
    expect(root.style.setProperty).toHaveBeenCalledWith('--ui-factor', String(uiFactor(150)));
    expect(root.style.setProperty).toHaveBeenCalledWith('--editor-font-size', '18px');
    expect(root.style.setProperty).toHaveBeenCalledWith('--terminal-font-size', '20px');
    expect(root.dataset).toEqual({ uiScale: '150' });
  });
});
