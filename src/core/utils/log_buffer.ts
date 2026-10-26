export interface LogLine { t: string; level: string; msg: string; seq: number }
export const MAX_LOG_LINES = 1000;
export const MAX_LOG_CHARS = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 65536;

/** Streaming UTF-8 decoding and bounded history, including unterminated oversized lines. */
export class LogBuffer {
  private decoder = new TextDecoder();
  private pending = '';
  private dropping = false;
  private sequence = 0;
  private chars = 0;
  lines: LogLine[] = [];
  truncated = false;
  private maxLines: number;

  constructor(maxLines: number = MAX_LOG_LINES) {
    this.maxLines = maxLines;
  }

  push(data: number[], final = false): void {
    const text = this.decoder.decode(new Uint8Array(data), { stream: !final });
    const parts = text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!this.dropping) {
        const available = MAX_LINE_CHARS - this.pending.length;
        this.pending += part.slice(0, available);
        if (part.length > available) { this.pending += ' … [line truncated]'; this.dropping = true; this.truncated = true; }
      }
      if (index < parts.length - 1) { this.append(this.pending); this.pending = ''; this.dropping = false; }
    }
    if (final && this.pending) { this.append(this.pending); this.pending = ''; this.dropping = false; }
  }
  private append(text: string): void {
    const match = /^(\d{4}-\d\d-\d\dT\S+)\s(.*)$/.exec(text.replace(/\r$/, ''));
    const msg = match?.[2] ?? text.replace(/\r$/, '');
    const t = match?.[1] ?? '';
    this.lines.push({ t, msg, seq: ++this.sequence, level: /\b(?:error|err|fatal|critical|crit|emerg(?:ency)?|alert)\b/i.test(msg) ? 'error' : /\bwarn(?:ing)?\b/i.test(msg) ? 'warn' : /\b(?:debug|trace)\b/i.test(msg) ? 'debug' : 'info' });
    this.chars += msg.length + t.length;
    while (this.lines.length > this.maxLines || this.chars > MAX_LOG_CHARS) {
      const removed = this.lines.shift()!; this.chars -= removed.msg.length + removed.t.length; this.truncated = true;
    }
  }
  /** Add one already-decoded line; used by the poller to skip refetched lines. */
  addLine(text: string): void {
    if (this.dropping || this.pending) throw new Error('addLine is only valid between complete reads');
    this.append(text);
  }
  clear(): void { this.lines = []; this.chars = 0; this.pending = ''; this.dropping = false; this.truncated = false; }
}

/** One nanosecond past `t`, so polls resume after an already-shown line. */
export function bumpLogTimestamp(t: string): string {
  const text = t.trim();
  const match = /^(.+?)(\.\d+)?(Z|z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) return text;
  if (!match[2]) return `${match[1]}.000000001${match[3]}`;
  const digits = match[2].length - 1;
  const value = Number(match[2].slice(1)) + 1;
  if (!Number.isSafeInteger(value) || value.toString().length > digits) return text;
  return `${match[1]}.${value.toString().padStart(digits, '0')}${match[3]}`;
}
