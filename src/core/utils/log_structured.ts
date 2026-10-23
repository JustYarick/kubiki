/**
 * Optional structured-log rendering: JSON lines are split into a message and
 * `key=value` fields like Grafana's structured viewers. Disabled by default —
 * lines that are not JSON render exactly as before.
 */

export type StructuredLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ParsedStructuredLog {
  level?: StructuredLogLevel;
  message?: string;
  fields: Array<[string, string]>;
}

const LEVEL_KEYS = ['level', 'lvl', 'severity', 'sev', 'loglevel', 'log_level', 'priority'];
const MESSAGE_KEYS = ['msg', 'message', 'log', 'event', 'messageText', 'text'];
const IGNORED_KEYS = new Set([...LEVEL_KEYS, ...MESSAGE_KEYS]);

const LEVEL_MAP: Record<string, StructuredLogLevel> = {
  error: 'error', err: 'error', fatal: 'error', critical: 'error', alert: 'error', emergency: 'error',
  warning: 'warn', warn: 'warn',
  info: 'info', informational: 'info', notice: 'info',
  debug: 'debug', trace: 'debug', verbose: 'debug',
};

const formatFieldValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};

/** Parses one log line as JSON. Returns null for non-JSON or empty objects. */
export function parseStructuredLog(line: string): ParsedStructuredLog | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return null;
  let level: StructuredLogLevel | undefined;
  let message: string | undefined;
  const fields: Array<[string, string]> = [];
  for (const key of LEVEL_KEYS) {
    const entry = entries.find(([name]) => name.toLowerCase() === key);
    if (!entry) continue;
    const candidate = LEVEL_MAP[formatFieldValue(entry[1]).toLowerCase()];
    if (candidate) { level = candidate; break; }
  }
  for (const key of MESSAGE_KEYS) {
    const entry = entries.find(([name]) => name.toLowerCase() === key);
    if (!entry) continue;
    const text = formatFieldValue(entry[1]);
    if (text) { message = text; break; }
  }
  for (const [key, value] of entries) {
    if (message !== undefined && MESSAGE_KEYS.includes(key.toLowerCase())) continue;
    if (IGNORED_KEYS.has(key.toLowerCase()) && level && message) continue;
    fields.push([key, formatFieldValue(value)]);
  }
  return { level, message, fields };
}

/** Serialises parsed fields for the muted `k=v` trail after the message. */
export function structuredFieldsText(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => `${key}=${value}`).join(' ');
}
