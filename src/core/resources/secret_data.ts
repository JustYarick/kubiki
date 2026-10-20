/** Secret values stay in memory. Text uses strict UTF-8; binary data keeps its base64 form. */
export interface SecretRow { id: number; key: string; value: string; mode: 'text' | 'base64' }
export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64 value');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (encodeBytes(bytes) !== value) throw new Error('Invalid base64 value');
  return bytes;
}
function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export const encodeText = (value: string) => encodeBytes(new TextEncoder().encode(value));
export function secretRows(data: Record<string, string>): SecretRow[] {
  return Object.entries(data).map(([key, value], id) => {
    try { return { id, key, value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodeBase64(value)), mode: 'text' }; }
    catch { return { id, key, value, mode: 'base64' }; }
  });
}
export function encodeSecretRows(rows: SecretRow[]): Record<string, string> {
  const data: Record<string, string> = Object.create(null);
  let size = 0;
  for (const row of rows) {
    if (!/^[A-Za-z0-9._-]+$/.test(row.key) || row.key.length > 253) throw new Error('Keys must contain 1–253 letters, numbers, dots, underscores or hyphens');
    if (Object.prototype.hasOwnProperty.call(data, row.key)) throw new Error('Secret keys must be unique');
    const encoded = row.mode === 'text' ? encodeText(row.value) : row.value;
    size += decodeBase64(encoded).length;
    if (size > 1024 * 1024) throw new Error('Secret data exceeds 1 MiB');
    data[row.key] = encoded;
  }
  return data;
}
