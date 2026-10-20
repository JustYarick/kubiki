/** Kubernetes Quantity in base units: CPU cores or memory bytes. Invalid/missing is never zero. */
export function quantity(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)((?:[eE][+-]?\d+)|(?:[numkKMGTPE]|[KMGTPE]i))?$/.exec(value);
  if (!match) return null;
  const suffix = match[2] ?? '';
  const powers: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  const factor = suffix ? /^[eE][+-]?\d+$/.test(suffix) ? 10 ** Number(suffix.slice(1)) : powers[suffix] : 1;
  const result = Number(match[1]) * factor;
  return Number.isFinite(result) && result >= 0 ? result : null;
}
export function cpuText(value: number | null): string { return value === null ? '—' : value > 0 && value < 1 ? `${Number((value * 1000).toFixed(1))}m` : `${Number(value.toFixed(2))} cores`; }
export function memoryText(value: number | null): string {
  if (value === null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${Number(value.toFixed(index > 1 ? 2 : 0))} ${units[index]}`;
}
