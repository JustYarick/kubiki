import { describe, it, expect } from 'vitest';
import { secretRows, encodeSecretRows, encodeText } from '../../src/core/resources/secret_data';
describe('Secret data codecs', () => {
  it('round trips Unicode, BOM, multiline, empty and binary without replacing bytes', () => {
    const data = { text: encodeText('\uFEFFПривет 🌍\nline\r\n'), empty: '', binary: '/wAB' };
    const rows = secretRows(data);
    expect(rows[0]).toMatchObject({ mode: 'text', value: '\uFEFFПривет 🌍\nline\r\n' });
    expect(rows[2]).toMatchObject({ mode: 'base64', value: '/wAB' });
    expect(encodeSecretRows(rows)).toEqual(data);
  });
  it('rejects duplicate/invalid keys, malformed or noncanonical base64 and oversized data', () => {
    const row = { id: 0, key: 'key', value: '', mode: 'text' as const };
    for (const rows of [[row, row], [{ ...row, key: 'bad/key' }], [{ ...row, value: '!!', mode: 'base64' as const }], [{ ...row, value: 'Zh==', mode: 'base64' as const }], [{ ...row, value: 'x'.repeat(1048577) }]]) expect(() => encodeSecretRows(rows)).toThrow();
  });
  it('encodes new keys and deletions, including prototype-like names', () => {
    expect(encodeSecretRows([{ id: 0, key: '__proto__', value: 'hello', mode: 'text' }])).toEqual({ ['__proto__']: 'aGVsbG8=' });
    expect(encodeSecretRows([])).toEqual({});
  });
});
