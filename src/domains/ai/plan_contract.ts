import type { PlanArtifact } from './types';
/** Fail closed for old/malformed payloads; prose and reasoning are never plan artifacts. */
export function isPlanArtifact(input: unknown): input is PlanArtifact {
  if (!input || typeof input !== 'object') return false;
  const p = input as Partial<PlanArtifact>;
  return p.schemaVersion === 1 && typeof p.sessionId === 'string' && !!p.sessionId && typeof p.id === 'string' && Number.isInteger(p.version) && (p.version ?? 0) > 0
    && ['remediation', 'investigation', 'deployment'].includes(String(p.kind)) && typeof p.title === 'string' && p.title.length <= 200
    && typeof p.diagnosis === 'string' && typeof p.uncertainty === 'string' && typeof p.bodyMarkdown === 'string' && p.bodyMarkdown.length <= 24000
    && !!p.scope && typeof p.scope.context === 'string' && Array.isArray(p.scope.namespaces)
    && Array.isArray(p.steps) && p.steps.length > 0 && p.steps.length <= 16
    && p.steps.every(s => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.reason === 'string'
      && typeof s.risk === 'string' && typeof s.verification === 'string' && ['inspect', 'manual', 'apply', 'scale', 'restart', 'delete'].includes(s.action));
}
