import type { ResourceRef } from '../core/resources/resource_types';
export type ReviewWarning = 'dependents' | 'crd_deletion' | 'namespace_deletion' | 'pod_disruption_budget' | 'argo_prune';
export interface ReviewStep { operation: string; resource: ResourceRef; summary: string; diff?: string }
export interface MutationReview { kind: 'action' | 'yaml' | 'batch'; steps: ReviewStep[]; warnings: ReviewWarning[] }
export const REVIEW_WARNINGS: Record<ReviewWarning, string> = {
  dependents: 'Controllers or garbage collection may create or remove dependent resources.',
  crd_deletion: 'Deleting a CRD deletes all custom resources defined by it across namespaces.',
  namespace_deletion: 'Deleting a Namespace removes its namespaced contents.',
  pod_disruption_budget: 'Evictions respect PodDisruptionBudgets. Kubernetes may refuse an eviction.',
  argo_prune: 'Pruning is enabled. Argo CD may delete resources that are absent from the desired state.',
};
