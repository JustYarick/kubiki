import { describe, expect, it } from 'vitest';
import { deliveryState } from '../../src/core/resources/delivery';
import type { ResourceItem } from '../../src/types/k8s';

const flux = (status: any, extra: any = {}): ResourceItem => ({ uid: 'flux', name: 'app', kind: 'Kustomization', apiVersion: 'kustomize.toolkit.fluxcd.io/v1', raw: { status, ...extra } });
const argo = (health: string, sync: string, phase?: string): ResourceItem => ({ uid: 'argo', name: 'app', kind: 'Application', apiVersion: 'argoproj.io/v1alpha1', raw: { status: { health: { status: health }, sync: { status: sync }, operationState: { phase } } } });

describe('delivery state', () => {
  it('keeps Argo sync drift and failed operations visible even when health is good', () => {
    expect(deliveryState(argo('Healthy', 'Synced'))).toBe('healthy');
    expect(deliveryState(argo('Healthy', 'OutOfSync'))).toBe('attention');
    expect(deliveryState(argo('Healthy', 'Synced', 'Failed'))).toBe('attention');
    expect(deliveryState(argo('Healthy', 'Synced', 'Running'))).toBe('progressing');
    expect(deliveryState(argo('Degraded', 'Synced'))).toBe('attention');
    expect(deliveryState(argo('Healthy', 'Unknown'))).toBe('unknown');
  });
  it('does not treat stale readiness or missing conditions as healthy', () => {
    expect(deliveryState(flux({ conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }] }, { metadata: { generation: 2 } }))).toBe('progressing');
    expect(deliveryState(flux({}))).toBe('unknown');
    expect(deliveryState(flux({ conditions: [{ type: 'Ready', status: 'Unknown' }] }))).toBe('unknown');
    expect(deliveryState(flux({ conditions: [{ type: 'Ready', status: 'False' }] }))).toBe('attention');
  });
  it('gives suspend and reconciliation precedence over old Ready conditions', () => {
    const conditions = [{ type: 'Ready', status: 'True' }];
    expect(deliveryState(flux({ conditions }))).toBe('healthy');
    expect(deliveryState(flux({ conditions }, { spec: { suspend: true } }))).toBe('suspended');
    expect(deliveryState(flux({ conditions: [...conditions, { type: 'Reconciling', status: 'True' }] }))).toBe('progressing');
    expect(deliveryState(flux({ conditions: [...conditions, { type: 'Stalled', status: 'True' }] }))).toBe('attention');
  });
});
