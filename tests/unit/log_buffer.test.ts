import { expect, it } from 'vitest';
import { LogBuffer, MAX_LOG_CHARS, MAX_LOG_LINES, bumpLogTimestamp } from '../../src/core/utils/log_buffer';
const encode = (text: string) => [...new TextEncoder().encode(text)];
it('reconstructs split UTF-8 and lines, preserves unstructured text and flushes final output', () => {
  const buffer = new LogBuffer(); const bytes = encode('2026-10-20T08:00:00Z привет 🌍\nplain text\nerror last');
  for (const byte of bytes) buffer.push([byte]);
  expect(buffer.lines.map((line) => line.msg)).toEqual(['привет 🌍', 'plain text']);
  buffer.push([], true);
  expect(buffer.lines.at(-1)).toMatchObject({ msg: 'error last', t: '', level: 'error' });
  expect(buffer.lines[0].t).toBe('2026-10-20T08:00:00Z');
});
it('bounds history by line count and total text rather than only number of lines', () => {
  const buffer = new LogBuffer();buffer.push(encode(Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join('')));
  expect(buffer.lines).toHaveLength(MAX_LOG_LINES);expect(buffer.lines[0].msg).toBe('line 1000');expect(buffer.truncated).toBe(true);
  const large = new LogBuffer();for (let i = 0; i < 100; i++) large.push(encode('x'.repeat(60000) + '\n'));
  expect(large.lines.reduce((n, line) => n + line.msg.length + line.t.length, 0)).toBeLessThanOrEqual(MAX_LOG_CHARS);
});
it('bounds a stream with no newline, discards its excess and resumes at the next line', () => {
  const buffer = new LogBuffer();for (let i = 0; i < 100; i++) buffer.push(encode('x'.repeat(8192)));
  expect(buffer.lines).toHaveLength(0);buffer.push(encode('\nhealthy\n'));
  expect(buffer.lines[0].msg.length).toBeLessThan(65600);expect(buffer.lines[0].msg).toContain('[line truncated]');expect(buffer.lines[1].msg).toBe('healthy');
});
it('clear removes partial output and keeps sequence keys unique when new output arrives', () => {
  const buffer = new LogBuffer();buffer.push(encode('old\npartial'));const seq = buffer.lines[0].seq;buffer.clear();buffer.push(encode('new\n'));
  expect(buffer.lines).toHaveLength(1);expect(buffer.lines[0]).toMatchObject({ msg: 'new', seq: seq + 1 });expect(buffer.truncated).toBe(false);
});
it('bumps nanosecond timestamps so polls resume strictly past a cleared watermark', () => {
  expect(bumpLogTimestamp('2026-10-20T08:00:00.123456789Z')).toBe('2026-10-20T08:00:00.123456790Z');
  expect(bumpLogTimestamp('2026-10-20T08:00:00+03:00')).toBe('2026-10-20T08:00:00.000000001+03:00');
  expect(bumpLogTimestamp('2026-10-20T08:00:00Z')).toBe('2026-10-20T08:00:00.000000001Z');
  expect(bumpLogTimestamp('2026-10-20T08:00:00.999999999Z')).toBe('2026-10-20T08:00:00.999999999Z');
  expect(bumpLogTimestamp('plain text')).toBe('plain text');
});
it('pushes direct string text without needing byte arrays and preserves chunking', () => {
  const buffer = new LogBuffer();
  buffer.pushText('2026-10-20T08:00:00Z line 1\nline 2');
  expect(buffer.lines.map((line) => line.msg)).toEqual(['line 1']);
  buffer.pushText(' continued\n2026-10-20T08:00:02Z error occurred');
  expect(buffer.lines.map((line) => line.msg)).toEqual(['line 1', 'line 2 continued']);
  buffer.pushText('', true);
  expect(buffer.lines.map((line) => line.msg)).toEqual(['line 1', 'line 2 continued', 'error occurred']);
  expect(buffer.lines[2].level).toBe('error');
});

