import { expect, it } from 'vitest';
import { topologyReadiness } from '../../src/core/resources/topology_readiness';
import type { WatchState } from '../../src/providers/watch_types';

const watched = (kind: string, patch: Partial<WatchState> = {}): WatchState => ({query: {context: 'test', group: '', version: 'v1', kind, namespace: 'team'}, phase: 'live', hasSnapshot: true, ...patch});
const input = {context: 'test', namespace: 'team', kinds: ['Pod', 'Service'], availableKinds: ['Pod', 'Service'], mode: 'watch', connected: true, clusterLoading: false, watches: {}, loading: {}, errors: {}};

it('does not treat an empty not-yet-loaded map as a complete snapshot', () => {
  expect(topologyReadiness(input)).toMatchObject({ready: false, pending: ['Pod', 'Service']});
  expect(topologyReadiness({...input, watches: {Pod: watched('Pod')}})).toMatchObject({ready: false, pending: ['Service']});
  expect(topologyReadiness({...input, watches: {Pod: watched('Pod'), Service: watched('Service')}}).ready).toBe(true);
});
it('requires the selected context and complete namespace coverage', () => {
  expect(topologyReadiness({...input, watches: {Pod: watched('Pod', {query: {...watched('Pod').query, context: 'old'}}), Service: watched('Service')}}).ready).toBe(false);
  expect(topologyReadiness({...input, namespace: '["team","other"]', watches: {Pod: watched('Pod'), Service: watched('Service')}}).ready).toBe(false);
  expect(topologyReadiness({...input, watches: {Pod: watched('Pod', {query: {...watched('Pod').query, namespace: null}}), Service: watched('Service')}}).ready).toBe(true);
});
it('settles unavailable APIs without waiting forever and ignores events and unsupported kinds', () => {
  expect(topologyReadiness({...input, kinds: ['Pod', 'Service', 'Event', 'Job'], watches: {Pod: watched('Pod'), Service: watched('Service', {phase: 'failed', hasSnapshot: false})}})).toMatchObject({ready: true, unavailable: ['Service'], pending: []});
});
it('does not use stopped or connecting cached snapshots for first drawing', () => {
  for (const phase of ['connecting', 'stopped'] as const) expect(topologyReadiness({...input, watches: {Pod: watched('Pod', {phase}), Service: watched('Service')}}).ready).toBe(false);
});
it('waits for all demo snapshots and never publishes a disconnected cluster', () => {
  expect(topologyReadiness({...input, mode: 'demo', loading: {Pod: false}}).ready).toBe(false);
  expect(topologyReadiness({...input, mode: 'demo', loading: {Pod: false, Service: false}}).ready).toBe(true);
  expect(topologyReadiness({...input, mode: 'demo', connected: false, loading: {Pod: false, Service: false}}).ready).toBe(false);
});
