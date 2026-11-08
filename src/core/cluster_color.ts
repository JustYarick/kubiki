/**
 * Deterministic cluster color system.
 *
 * Hashes the cluster name using 32-bit FNV-1a to pick a consistent, vibrant
 * status-badge color palette. Different users/sessions will always see the
 * exact same color for the same cluster name, matching modern cloud status pills.
 */

export interface ClusterTone {
  id: string;
  name: string;
  color: string;
  bg: string;
  border: string;
  dot: string;
}

/**
 * 32-bit FNV-1a hash algorithm.
 * Guarantees consistent 32-bit integer distribution across all environments.
 */
export function hashClusterName(name: string): number {
  let hash = 0x811c9dc5; // 2166136261
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // 16777619
  }
  return hash >>> 0;
}

export const CLUSTER_PALETTES: ClusterTone[] = [
  { id: 'emerald', name: 'Emerald', color: '#34d399', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.32)', dot: '#10b981' },
  { id: 'sky', name: 'Sky', color: '#38bdf8', bg: 'rgba(14, 165, 233, 0.12)', border: 'rgba(14, 165, 233, 0.32)', dot: '#0ea5e9' },
  { id: 'indigo', name: 'Indigo', color: '#818cf8', bg: 'rgba(99, 102, 241, 0.12)', border: 'rgba(99, 102, 241, 0.32)', dot: '#6366f1' },
  { id: 'purple', name: 'Purple', color: '#c084fc', bg: 'rgba(168, 85, 247, 0.12)', border: 'rgba(168, 85, 247, 0.32)', dot: '#a855f7' },
  { id: 'amber', name: 'Amber', color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.32)', dot: '#f59e0b' },
  { id: 'teal', name: 'Teal', color: '#2dd4bf', bg: 'rgba(20, 184, 166, 0.12)', border: 'rgba(20, 184, 166, 0.32)', dot: '#14b8a6' },
  { id: 'rose', name: 'Rose', color: '#fb7185', bg: 'rgba(244, 63, 94, 0.12)', border: 'rgba(244, 63, 94, 0.32)', dot: '#f43f5e' },
  { id: 'orange', name: 'Orange', color: '#fb923c', bg: 'rgba(249, 115, 22, 0.12)', border: 'rgba(249, 115, 22, 0.32)', dot: '#f97316' },
  { id: 'cyan', name: 'Cyan', color: '#22d3ee', bg: 'rgba(6, 182, 212, 0.12)', border: 'rgba(6, 182, 212, 0.32)', dot: '#06b6d4' },
  { id: 'fuchsia', name: 'Fuchsia', color: '#e879f9', bg: 'rgba(217, 70, 239, 0.12)', border: 'rgba(217, 70, 239, 0.32)', dot: '#d946ef' },
  { id: 'lime', name: 'Lime', color: '#a3e635', bg: 'rgba(132, 204, 22, 0.12)', border: 'rgba(132, 204, 22, 0.32)', dot: '#84cc16' },
  { id: 'blue', name: 'Blue', color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.32)', dot: '#3b82f6' },
];

export function getClusterTone(clusterName?: string | null): ClusterTone {
  if (!clusterName || clusterName === 'general') {
    return {
      id: 'general',
      name: 'General',
      color: 'var(--text-muted)',
      bg: 'var(--bg-secondary)',
      border: 'var(--border-default)',
      dot: 'var(--text-muted)',
    };
  }
  if (clusterName === '*') {
    return {
      id: 'all',
      name: 'All clusters',
      color: 'var(--accent)',
      bg: 'rgba(99, 102, 241, 0.12)',
      border: 'rgba(99, 102, 241, 0.32)',
      dot: 'var(--accent)',
    };
  }
  const hash = hashClusterName(clusterName.trim().toLowerCase());
  return CLUSTER_PALETTES[hash % CLUSTER_PALETTES.length];
}
