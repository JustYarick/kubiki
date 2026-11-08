import type { ResourceRef } from '../core/resources/resource_types';
export type ReviewWarning = 'dependents' | 'crd_deletion' | 'namespace_deletion' | 'pod_disruption_budget' | 'argo_prune';
export interface ReviewStep { operation: string; resource: ResourceRef; summary: string; diff?: string }
export interface MutationReview { kind: 'action' | 'yaml' | 'batch'; steps: ReviewStep[]; warnings: ReviewWarning[] }
