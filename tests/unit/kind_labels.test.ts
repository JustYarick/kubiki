import { describe, it, expect } from 'vitest';
import { friendlyKindName, summaryTitle, pluralize } from '../../src/core/resources/kind_labels';

describe('kind labels', () => {
  it('uses readable names for the kinds without a dedicated panel', () => {
    expect(friendlyKindName('ResourceQuota')).toBe('Resource quota');
    expect(friendlyKindName('PodDisruptionBudget')).toBe('Pod disruption budget');
    expect(friendlyKindName('MutatingWebhookConfiguration')).toBe('Mutating webhook configuration');
    expect(friendlyKindName('ValidatingAdmissionPolicyBinding')).toBe('Validating admission policy binding');
  });

  it('keeps acronyms readable', () => {
    expect(friendlyKindName('HTTPRoute')).toBe('HTTP route');
    expect(friendlyKindName('GRPCRoute')).toBe('GRPC route');
  });

  it('builds the shared summary title', () => {
    expect(summaryTitle('ResourceQuota')).toBe('Resource quota summary');
    expect(summaryTitle('LimitRange')).toBe('Limit range summary');
    expect(summaryTitle('Pod')).toBe('Pod summary');
    expect(summaryTitle('HorizontalPodAutoscaler')).toBe('Horizontal pod autoscaler summary');
  });

  it('pluralizes counters', () => {
    expect(pluralize(1, 'webhook')).toBe('1 webhook');
    expect(pluralize(2, 'webhook')).toBe('2 webhooks');
  });
});
