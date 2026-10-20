/** Fit automatic columns into a fresh pane; persisted/manual widths remain exact. */
export function fitTableColumns(ids: string[], available: number, defaults: Record<string, number>, manual: Record<string, number> = {}): Record<string, number> {
  const widths: Record<string, number> = {};
  const minimum = (id: string) => id === 'name' ? 120 : id === 'namespace' || id === 'status' ? 90 : 56;
  let remaining = Math.max(0, available);
  const flexible = ids.filter(id => {
    if (id !== '__index' && !Number.isFinite(manual[id])) return true;
    widths[id] = Math.max(id === '__index' ? 28 : 56, Math.min(520, manual[id] ?? defaults[id] ?? 38));
    remaining -= widths[id]; return false;
  });
  const value = (id: string, scale: number) => Math.max(minimum(id), Math.min(520, (defaults[id] ?? 120) * scale));
  // Monotonic bounded allocation handles simultaneous minimum and maximum constraints.
  let low = 0, high = 520 / Math.min(...flexible.map(id => defaults[id] ?? 120), 1);
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (flexible.reduce((sum, id) => sum + value(id, mid), 0) < remaining) low = mid; else high = mid;
  }
  for (const id of flexible) widths[id] = Math.round(value(id, (low + high) / 2) * 100) / 100;
  return widths;
}
