import { describe, expect, it } from 'vitest';
import { logTimestampFormatter } from '../../src/core/utils/log_timestamp';

describe('Log timestamp presentation', () => {
  it('preserves UTC precision and normalizes explicit source offsets', () => {
    const format = logTimestampFormatter('utc', 'Europe/Moscow');
    expect(format('2026-10-20T08:00:00.123456789Z')).toBe('2026-10-20T08:00:00.123456789Z');
    expect(format('2026-10-20T01:00:00.123456789+03:00')).toBe('2026-10-19T22:00:00.123456789Z');
  });
  it('converts local dates across midnight while retaining all fractional digits', () => {
    const format = logTimestampFormatter('local', 'Europe/Moscow');
    expect(format('2026-12-31T23:00:00.000000001Z')).toBe('2027-01-01T02:00:00.000000001+03:00');
  });
  it('uses the offset at the log instant, including both daylight saving transitions', () => {
    const format = logTimestampFormatter('local', 'America/New_York');
    expect(format('2026-03-08T06:59:59Z')).toBe('2026-03-08T01:59:59-05:00');
    expect(format('2026-03-08T07:00:00Z')).toBe('2026-03-08T03:00:00-04:00');
    expect(format('2026-11-01T05:30:00Z')).toBe('2026-11-01T01:30:00-04:00');
    expect(format('2026-11-01T06:30:00Z')).toBe('2026-11-01T01:30:00-05:00');
  });
  it('supports fractional-hour system time zones', () => {
    expect(logTimestampFormatter('local', 'Asia/Kathmandu')('2026-10-20T00:00:00.12Z')).toBe('2026-10-20T05:45:00.12+05:45');
  });
  it('leaves missing, invalid, or ambiguous timestamps untouched', () => {
    const format = logTimestampFormatter('local', 'Europe/Moscow');
    for (const timestamp of ['', 'invalid', '12:00:00.123', '2026-10-20T08:00:00', '2026-99-20T08:00:00Z']) expect(format(timestamp)).toBe(timestamp);
  });
});
