import { expect, it } from 'vitest';
import { parseStructuredLog, structuredFieldsText } from '../../src/core/utils/log_structured';

it('splits JSON records into message, level and k=v fields like Grafana', () => {
  const parsed = parseStructuredLog('{"level":"error","ts":"2026-10-20T08:00:00Z","msg":"connection refused","host":"web.backend","attempt":3}');
  expect(parsed).toEqual({
    level: 'error',
    message: 'connection refused',
    fields: [['ts', '2026-10-20T08:00:00Z'], ['host', 'web.backend'], ['attempt', '3']],
  });
  expect(structuredFieldsText(parsed!.fields)).toBe('ts=2026-10-20T08:00:00Z host=web.backend attempt=3');
});

it('maps common level spellings and message aliases', () => {
  expect(parseStructuredLog('{"severity":"FATAL","message":"boom"}')).toMatchObject({ level: 'error', message: 'boom' });
  expect(parseStructuredLog('{"lvl":"Warning","log":"slow"}')).toMatchObject({ level: 'warn', message: 'slow' });
  expect(parseStructuredLog('{"loglevel":"verbose","event":"hop"}')).toMatchObject({ level: 'debug', message: 'hop' });
  expect(parseStructuredLog('{"severity":"notice","msg":"ok"}')).toMatchObject({ level: 'info', message: 'ok', fields: [] });
});

it('leaves unknown levels with plain fields and keeps raw rendering for non-JSON', () => {
  expect(parseStructuredLog('{"severity":"notice-nothing","msg":"s"}')).toMatchObject({ message: 's', fields: [['severity', 'notice-nothing']] });
  expect(parseStructuredLog('{"info":true,"msg":"ok"}')).toMatchObject({ level: undefined, message: 'ok', fields: [['info', 'true']] });
  expect(parseStructuredLog('{"sequenced":broken')).toBeNull();
  expect(parseStructuredLog('plain text line')).toBeNull();
  expect(parseStructuredLog('[2026] not an object')).toBeNull();
  expect(parseStructuredLog('{"level":"error"}')).not.toBeNull();
  expect(parseStructuredLog(JSON.stringify([1, 2]))).toBeNull();
  expect(parseStructuredLog('{"nested":{"a":[1]}}')!.fields).toEqual([['nested', '{"a":[1]}']]);
});

it('handles production logs with timestamp prefixes, ANSI codes and numeric levels like Pino', () => {
  // Timestamp prefix before JSON
  expect(parseStructuredLog('2026-10-26T10:15:30.123456789Z {"level":"info","msg":"server ready"}')).toMatchObject({
    level: 'info',
    message: 'server ready',
  });
  // ANSI colors
  expect(parseStructuredLog('\x1b[32m{"level":"warn","message":"cache miss"}\x1b[0m')).toMatchObject({
    level: 'warn',
    message: 'cache miss',
  });
  // Pino numeric levels: 30 = info, 40 = warn, 50 = error
  expect(parseStructuredLog('{"level":50,"time":1600000000,"msg":"database connection failed"}')).toMatchObject({
    level: 'error',
    message: 'database connection failed',
  });
  expect(parseStructuredLog('{"level":30,"time":1600000000,"msg":"handled request"}')).toMatchObject({
    level: 'info',
    message: 'handled request',
  });
});
