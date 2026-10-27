/**
 * Optional structured-log rendering: JSON lines are split into a message and
 * `key=value` fields like Grafana's structured viewers. Disabled by default —
 * lines that are not JSON render exactly as before.
 */

export type StructuredLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ParsedStructuredLog {
  level?: StructuredLogLevel;
  message?: string;
  prefix?: string;
  suffix?: string;
  fields: Array<[string, string]>;
}

const LEVEL_KEYS = ['level', 'lvl', 'severity', 'sev', 'loglevel', 'log_level', 'priority', 'levelname'];
const MESSAGE_KEYS = ['msg', 'message', 'log', 'event', 'messagetext', 'text', 'description', 'payload', 'body', 'action'];

const LEVEL_MAP: Record<string, StructuredLogLevel> = {
  error: 'error', err: 'error', fatal: 'error', critical: 'error', crit: 'error', alert: 'error', emergency: 'error', emerg: 'error',
  warning: 'warn', warn: 'warn',
  info: 'info', informational: 'info', information: 'info', notice: 'info',
  debug: 'debug', trace: 'debug', verbose: 'debug',
};

const normalizeLogLevel = (rawVal: unknown): StructuredLogLevel | undefined => {
  if (rawVal === null || rawVal === undefined) return undefined;
  if (typeof rawVal === 'number') {
    if (rawVal >= 50 && rawVal <= 70) return 'error'; // Pino 50=error, 60=fatal
    if (rawVal >= 40 && rawVal < 50) return 'warn';   // Pino 40=warn
    if (rawVal >= 30 && rawVal < 40) return 'info';   // Pino 30=info
    if (rawVal >= 10 && rawVal < 30) return 'debug';  // Pino 10=trace, 20=debug
    if (rawVal >= 500) return 'error';                // HTTP 5xx
    if (rawVal >= 400) return 'warn';                 // HTTP 4xx
    if (rawVal >= 200 && rawVal < 400) return 'info'; // HTTP 2xx, 3xx
    return undefined;
  }
  const str = String(rawVal).trim().toLowerCase();
  const candidate = LEVEL_MAP[str];
  if (candidate) return candidate;
  const num = Number(str);
  if (!Number.isNaN(num) && str.length > 0) {
    if (num >= 50 && num <= 70) return 'error';
    if (num >= 40 && num < 50) return 'warn';
    if (num >= 30 && num < 40) return 'info';
    if (num >= 10 && num < 30) return 'debug';
    if (num >= 500) return 'error';
    if (num >= 400) return 'warn';
    if (num >= 200 && num < 400) return 'info';
  }
  return undefined;
};

const formatFieldValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};

/** Parses one log line as JSON. Returns null for non-JSON or empty objects. */
export function parseStructuredLog(line: string): ParsedStructuredLog | null {
  if (!line || typeof line !== 'string') return null;
  // Strip ANSI color codes
  const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const trimmed = stripped.trim();

  // Find boundaries of JSON object even if preceded by timestamps or logger names
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;

  const jsonCandidate = trimmed.slice(firstBrace, lastBrace + 1);
  let value: unknown;
  try { value = JSON.parse(jsonCandidate); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return null;
  let level: StructuredLogLevel | undefined;
  let message: string | undefined;
  let levelKey: string | undefined;
  let messageKey: string | undefined;
  const fields: Array<[string, string]> = [];
  for (const key of LEVEL_KEYS) {
    const entry = entries.find(([name]) => name.toLowerCase() === key);
    if (!entry) continue;
    const candidate = normalizeLogLevel(entry[1]);
    if (candidate) { level = candidate; levelKey = entry[0]; break; }
  }
  for (const key of MESSAGE_KEYS) {
    const entry = entries.find(([name]) => name.toLowerCase() === key);
    if (!entry) continue;
    const text = formatFieldValue(entry[1]);
    if (text) { message = text; messageKey = entry[0]; break; }
  }
  for (const [key, val] of entries) {
    if (key === messageKey || key === levelKey) continue;
    fields.push([key, formatFieldValue(val)]);
  }
  const prefix = trimmed.slice(0, firstBrace).trim();
  const suffix = trimmed.slice(lastBrace + 1).trim();
  return { level, message, fields, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

/** Serialises parsed fields for the muted `k=v` trail after the message. */
export function structuredFieldsText(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => `${key}=${value}`).join(' ');
}
