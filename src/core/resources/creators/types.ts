import type { NewResourceType } from '../new_resource';

export type CreatorMode = 'form' | 'yaml';

export interface KeyValueEntry {
  id: number;
  key: string;
  value: string;
}

/**
 * Pure model contract for a resource creator.
 * Each creator hydrates editable form state from a parsed manifest object and
 * patches the live YAML document back without dropping comments or unmodeled
 * Kubernetes fields.
 */
export interface ResourceCreatorModel<TState> {
  /** Exact Kubernetes API group (`''` for core/v1). */
  group: string;
  /** Exact Kubernetes resource kind. */
  kind: string;
  /** Short subtitle displayed in the form header. */
  description: string;
  /** Whether the shared Labels & Annotations section starts expanded. */
  defaultMetadataOpen?: boolean;
  /** Re-hydrate form state when metadata labels/annotations change in the shared editor. */
  syncOnMetadataChange?: boolean;
  /** Hydrate structured form state from a parsed Kubernetes object. */
  fromObject: (object: Record<string, any>, type: NewResourceType) => TState;
  /** Patch the existing YAML manifest string with the current form state. */
  applyToManifest: (manifest: string, state: TState, type: NewResourceType) => string;
  /** Return a blocking form-level validation message, or an empty string if valid. */
  validate: (state: TState, type: NewResourceType) => string;
}
