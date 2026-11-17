export type LogTimestampZone = 'utc' | 'local';

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Presentation only: preserve source precision in UTC and format compact local wall-clock time. */
export function logTimestampFormatter(mode: LogTimestampZone, localZone = systemTimeZone()): (timestamp: string) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: mode === 'utc' ? 'UTC' : localZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  return timestamp => {
    // A time without a date/offset cannot be converted unambiguously.
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/i.exec(timestamp);
    if (!match) return timestamp;
    if (mode === 'utc' && match[3] === 'Z') return timestamp;
    const date = new Date(`${match[1]}${match[2]?.slice(0, 4) ?? ''}${match[3]}`);
    if (Number.isNaN(date.getTime())) return timestamp;
    const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
    if (mode === 'utc') {
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${match[2] ?? ''}Z`;
    }
    const ms = match[2] ? match[2].slice(0, 4) : '';
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${ms}`;
  };
}
