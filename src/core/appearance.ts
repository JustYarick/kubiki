export const DEFAULT_APPEARANCE = { uiScale: 110, editorFontSize: 14, terminalFontSize: 14 };
export const APPEARANCE_LIMITS = { uiScale: [80, 200], editorFontSize: [10, 24], terminalFontSize: [10, 24] } as const;
export type Appearance = typeof DEFAULT_APPEARANCE;

export function appearanceValue(key: keyof Appearance, value: unknown): number {
  const [min, max] = APPEARANCE_LIMITS[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : DEFAULT_APPEARANCE[key];
}

export function normalizeAppearance(value: Partial<Appearance> | undefined): Appearance {
  return {
    uiScale: appearanceValue('uiScale', value?.uiScale),
    editorFontSize: appearanceValue('editorFontSize', value?.editorFontSize),
    terminalFontSize: appearanceValue('terminalFontSize', value?.terminalFontSize),
  };
}

/** Existing geometry was authored at 12px. 100% now uses the IDE baseline of 13px. */
export function uiFactor(scale: number): number { return (13 / 12) * (appearanceValue('uiScale', scale) / 100); }
export function uiPixels(value: number): string { return `calc(${value}px * var(--ui-factor))`; }

export function applyAppearance(root: HTMLElement, value: Appearance): void {
  const settings = normalizeAppearance(value);
  root.style.setProperty('--ui-factor', String(uiFactor(settings.uiScale)));
  root.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`);
  root.style.setProperty('--terminal-font-size', `${settings.terminalFontSize}px`);
  root.dataset.uiScale = String(settings.uiScale);
}
