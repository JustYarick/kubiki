/**
 * Group color system.
 *
 * Every top-level Kubernetes object group owns one base hue; the kinds inside a
 * group are shades of that hue. This module is the single source of truth — the
 * sidebar, kind badges, resource tables, topology and details all read from it,
 * so a kind never changes color between views.
 *
 * The palette is tuned for the dark JetBrains canvas (#1e1f22): every generated
 * shade keeps at least 4.5:1 contrast against it, so color can carry meaning.
 */

export const GROUP_IDS = [
  'nodes',
  'workloads',
  'config',
  'network',
  'storage',
  'namespaces',
  'events',
  'helm',
  'access',
  'admission',
  'gateway',
  'devices',
  'flux',
  'argocd',
  'crd',
] as const;

export type GroupId = typeof GROUP_IDS[number];

/** Base hue per group. Pick hues that stay apart from their neighbours in the tree. */
export const GROUP_BASE: Record<GroupId, string> = {
  nodes: '#7e9fff',
  workloads: '#b39aff',
  config: '#56c8d8',
  network: '#73daca',
  storage: '#e5b742',
  namespaces: '#b5cea8',
  events: '#9da0a8',
  helm: '#ffb86c',
  access: '#e06c75',
  admission: '#c792ea',
  gateway: '#89ddff',
  devices: '#ff9e64',
  flux: '#4ec9b0',
  argocd: '#d08770',
  crd: '#c586c0',
};

export const GROUP_LABEL: Record<GroupId, string> = {
  nodes: 'Nodes',
  workloads: 'Workloads',
  config: 'Configuration',
  network: 'Network',
  storage: 'Storage',
  namespaces: 'Namespaces',
  events: 'Events',
  helm: 'Helm',
  access: 'Access Control',
  admission: 'Admission Policies',
  gateway: 'Gateway API',
  devices: 'Device Resources',
  flux: 'Flux',
  argocd: 'Argo CD',
  crd: 'Custom Resources',
};

export interface Tone {
  /** Solid color for icons and text. */
  color: string;
  /** Translucent fill for badges and chips. */
  bg: string;
  /** Translucent border for badges and chips. */
  border: string;
}

/** Hue used when a kind cannot be traced back to a group. */
export const NEUTRAL_COLOR = '#9da0a8';

const LIGHT_TARGET = '#eef4ff';

/* ------------------------------------------------------------------ */
/* Color math                                                          */
/* ------------------------------------------------------------------ */

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  const number = Number.parseInt(full.slice(0, 6), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

const toLinear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (channel: number): number => {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(value * 255)));
};

/** Mix two colors in linear light so shades keep their hue. */
export function mix(first: string, second: string, amount: number): string {
  const a = parseHex(first);
  const b = parseHex(second);
  const t = Math.max(0, Math.min(1, amount));
  const channels = a.map((channel, index) => fromLinear(toLinear(channel) * (1 - t) + toLinear(b[index]) * t));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Shade of a base hue. Even entries walk towards the light target, odd entries
 * stay one step darker — neighbours inside a group differ in lightness, not
 * only in hue, so a group reads as one family while its members stay apart.
 */
export function shade(base: string, index: number, total: number): string {
  const steps = Math.max(1, total - 1);
  const position = Math.max(0, Math.min(steps, index));
  let amount = 0.05 + (0.7 * position) / steps;
  if (index % 2 === 1) amount = Math.max(0, amount - 0.2);
  return mix(base, LIGHT_TARGET, amount);
}

export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function toneOf(color: string): Tone {
  return { color, bg: withAlpha(color, 0.16), border: withAlpha(color, 0.34) };
}

export const NEUTRAL_TONE: Tone = toneOf(NEUTRAL_COLOR);

/** Hues used for kinds that were discovered at runtime (CRDs, GitOps families). */
const RUNTIME_TONES = new Map<string, Tone>();

/** Publish the resolved tone of a kind so every view shows the same color. */
export function registerTone(key: string, tone: Tone): void {
  RUNTIME_TONES.set(key, tone);
}

export function lookupTone(key: string): Tone | undefined {
  return RUNTIME_TONES.get(key);
}

/** Base hue of a group, optionally shifted to one of its shades. */
export function groupTone(group: GroupId, index = 0, total = 1): Tone {
  return toneOf(shade(GROUP_BASE[group], index, total));
}

/* ------------------------------------------------------------------ */
/* Dynamic API groups (CRDs, GitOps)                                   */
/* ------------------------------------------------------------------ */

/** Categorical hues for API groups that have no built-in counterpart. */
const API_GROUP_HUES = ['#c586c0', '#9ece6a', '#e0af68', '#7dcfff', '#bb9af7', '#2ac3de', '#ff9e64', '#e06c75', '#a3be8c', '#d4bfff'];

/** Deterministic hue for an API group — the same group always gets the same color. */
export function apiGroupHue(apiGroup: string): string {
  let hash = 0;
  for (const char of apiGroup) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return API_GROUP_HUES[hash % API_GROUP_HUES.length];
}

/** Base color of an API family: GitOps and Gateway families keep their group hue. */
export function familyBase(apiGroup: string): string {
  if (apiGroup.endsWith('.toolkit.fluxcd.io') || apiGroup === 'fluxcd.io') return GROUP_BASE.flux;
  if (apiGroup === 'argoproj.io') return GROUP_BASE.argocd;
  if (apiGroup === 'gateway.networking.k8s.io') return GROUP_BASE.gateway;
  if (apiGroup === 'autoscaling.k8s.io') return GROUP_BASE.config;
  return apiGroupHue(apiGroup);
}
