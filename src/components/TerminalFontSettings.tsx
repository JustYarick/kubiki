import { useEffect, useState } from 'react';
import { useUiStore } from '../state/ui_store';
import { loadTerminalFonts, terminalFontStack, TERMINAL_FONT_PRESETS } from '../core/terminal_appearance';
import { Button } from './ui/Button';

export function TerminalFontSettings() {
  const family = useUiStore(state => state.terminalFontFamily);
  const lineHeight = useUiStore(state => state.terminalLineHeight);
  const size = useUiStore(state => state.terminalFontSize);
  const [customMode, setCustomMode] = useState(!TERMINAL_FONT_PRESETS.some(font => font.value === family));
  const [draft, setDraft] = useState(family);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => { setDraft(family); setCustomMode(!TERMINAL_FONT_PRESETS.some(font => font.value === family)); }, [family]);
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    void loadTerminalFonts(family, size).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [family, size]);
  const preset = TERMINAL_FONT_PRESETS.some(font => font.value === family) ? family : 'custom';
  return <section aria-label="Terminal typography" className="space-y-2 py-2.5 min-w-0">
    <label className="block text-xs" htmlFor="terminal-font-preset">Terminal typeface</label>
    <select id="terminal-font-preset" aria-label="Terminal font preset" className="ide-select w-full max-w-full" value={customMode ? 'custom' : preset} onChange={event => {
      setCustomMode(event.target.value === 'custom');
      if (event.target.value === 'custom') document.getElementById('terminal-font-family')?.focus();
      else useUiStore.getState().setTerminalFontFamily(event.target.value);
    }}>
      {TERMINAL_FONT_PRESETS.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
      <option value="custom">Custom font family</option>
    </select>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex-1 min-w-0 basis-52 text-xs">Font family / fallback list
        <input id="terminal-font-family" aria-label="Terminal font family" className="ide-select w-full mt-1" value={draft} placeholder="'MesloLGS NF', monospace" spellCheck={false} autoComplete="off" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); useUiStore.getState().setTerminalFontFamily(draft); } }} />
      </label>
      <Button size="sm" aria-label="Apply terminal font" onClick={() => useUiStore.getState().setTerminalFontFamily(draft)}>Apply</Button>
    </div>
    <p className="text-xs text-[var(--text-secondary)]">Use the family name from your terminal preferences. Custom fonts must be installed on this PC. Nerd/Powerline symbols are bundled and work offline.</p>
    <label className="flex items-center justify-between gap-3 text-xs">Terminal line height
      <input aria-label="Terminal line height" type="number" min={1} max={2} step={0.05} value={lineHeight} onChange={event => { if (event.target.value) useUiStore.getState().setTerminalLineHeight(Number(event.target.value)); }} className="ide-select w-20" />
    </label>
    <pre aria-label="Terminal font preview" className="resource-data-value kubiki-scrollbar rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] p-3 whitespace-pre" style={{ fontFamily: terminalFontStack(family), fontSize: size, lineHeight }}>
      {'user@host ~/project   dev \n        󰐊  →  ✓  ┌─┐\n0123456789  Il1 O0  Hello'}
    </pre>
    {loadError && <p role="status" className="text-xs text-[var(--status-warn)]">A font could not be loaded; the terminal uses available fallback fonts.</p>}
    <p className="text-xs text-[var(--text-secondary)]">Applies to local, Pod and Node terminals without restarting sessions. The local terminal uses your default shell and its startup files; fonts are configured here separately.</p>
  </section>;
}
