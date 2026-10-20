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
    this.lines.push({ t, msg, seq: ++this.sequence, level: /\berror\b/i.test(msg) ? 'error' : /\bwarn(?:ing)?\b/i.test(msg) ? 'warn' : 'info' });
    this.chars += msg.length + t.length;
    while (this.lines.length > MAX_LOG_LINES || this.chars > MAX_LOG_CHARS) {
      const removed = this.lines.shift()!; this.chars -= removed.msg.length + removed.t.length; this.truncated = true;
    }
  }
  clear(): void { this.lines = []; this.chars = 0; this.pending = ''; this.dropping = false; this.truncated = false; }
}
