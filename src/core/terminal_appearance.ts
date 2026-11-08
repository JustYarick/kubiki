/** Font families are names/CSS family lists, never font URLs or executable CSS. */
export const DEFAULT_TERMINAL_FONT = "'JetBrains Mono Variable'";
export const DEFAULT_TERMINAL_BACKGROUND = '#1e1f22';

export const TERMINAL_FONT_PRESETS = [
  { label: 'JetBrains Mono + Nerd symbols (bundled)', value: DEFAULT_TERMINAL_FONT },
  { label: 'System monospace', value: 'monospace' },
  ...['MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'CaskaydiaCove Nerd Font Mono', 'Consolas', 'Menlo'].map(value => ({ label: value, value: `'${value}'` })),
];

export const TERMINAL_BACKGROUND_PRESETS = [
  { label: 'Default Dark (#1e1f22)', value: '#1e1f22' },
  { label: 'Pure Black (#000000)', value: '#000000' },
  { label: 'Slate Dark (#0f172a)', value: '#0f172a' },
  { label: 'Zinc (#18181b)', value: '#18181b' },
  { label: 'Deep Blue (#0b0f19)', value: '#0b0f19' },
  { label: 'Tokyo Night (#1a1b26)', value: '#1a1b26' },
  { label: 'Dracula (#282a36)', value: '#282a36' },
] as const;

export function normalizeTerminalBackground(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TERMINAL_BACKGROUND;
  const trimmed = value.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return DEFAULT_TERMINAL_BACKGROUND;
}

export function normalizeTerminalFont(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[{};\\\n\r]/.test(value)) return DEFAULT_TERMINAL_FONT;
  const family = value.trim();
  if (typeof CSS !== 'undefined' && !CSS.supports('font-family', family)) return DEFAULT_TERMINAL_FONT;
  return family || DEFAULT_TERMINAL_FONT;
}
export function terminalFontStack(value: unknown): string {
  return `${normalizeTerminalFont(value)}, 'Kubiki Nerd Symbols', 'Symbols Nerd Font Mono', 'JetBrains Mono Variable', monospace`;
}
export function normalizeTerminalLineHeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(1, Math.min(2, value)) * 100) / 100 : 1.2;
}
/** xterm measures cells before drawing. Load both text and icon faces before fitting. */
export async function loadTerminalFonts(family: string, size: number): Promise<void> {
  if (!document.fonts) return;
  await Promise.all([
    document.fonts.load(`${size}px ${terminalFontStack(family)}`, 'Mwm@0123'),
    document.fonts.load(`${size}px "Kubiki Nerd Symbols"`, '\ue0b0\ue0a0\uf120\uf013\uf07b\udb80\udf26'),
  ]);
}
