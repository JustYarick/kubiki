import type { ResourceRef } from '../core/resources/resource_types';
export interface SecretDataRequest { resource: ResourceRef; resource_version: string; data: Record<string, string> }
