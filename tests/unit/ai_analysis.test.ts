import { describe, expect, it } from 'vitest';
import { ANALYSIS_INSTRUCTIONS, ANALYSIS_PROMPT_LIMIT, buildAnalysisPrompt, normalizeAnalysisPrompt, normalizeAiAgent } from '../../src/core/ai_analysis';
import type { ResourceItem } from '../../src/types/k8s';

const pod: ResourceItem = { kind: 'Pod', apiVersion: 'v1', name: 'waiting', namespace: 'prod', uid: 'pod-1', status: 'Pending', raw: {
  metadata: { annotations: { credential: 'annotation-secret' } },
  spec: { nodeSelector: { accelerator: 'gpu' }, containers: [{ name: 'app', image: 'web:1', env: [{ name: 'PASSWORD', value: 'env-secret' }] }] },
  status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes: insufficient memory' }] },
} };
describe('AI diagnostic snapshot', () => {
  it('uses custom starting instructions while preserving the bounded, redacted snapshot', () => {
    const prompt = buildAnalysisPrompt(pod, 'prod', [], undefined, 'Reply in English with a concise root cause.');
    expect(prompt).toMatch(/^Reply in English with a concise root cause\./);
    expect(prompt).not.toContain(ANALYSIS_INSTRUCTIONS);
    expect(prompt).toContain('BEGIN UNTRUSTED DIAGNOSTIC SNAPSHOT');
    expect(prompt).toContain('insufficient memory');
    expect(prompt).not.toContain('env-secret');
    expect(normalizeAnalysisPrompt('  ')).toBe(ANALYSIS_INSTRUCTIONS);
    expect(normalizeAnalysisPrompt({})).toBe(ANALYSIS_INSTRUCTIONS);
    expect(normalizeAnalysisPrompt('x'.repeat(10000))).toHaveLength(ANALYSIS_PROMPT_LIMIT);
  });
  it('includes evidence for this resource and explicit restrictions without reading the cluster', () => {
    const event = (uid: string, message: string): ResourceItem => ({ kind: 'Event', apiVersion: 'v1', name: uid, uid, namespace: 'prod', raw: { involvedObject: { kind: 'Pod', apiVersion: 'v1', namespace: 'prod', name: 'waiting', uid }, reason: 'FailedScheduling', message } });
    const prompt = buildAnalysisPrompt(pod, 'production', [event('pod-1', 'Matching event'), event('old-pod', 'Unrelated event')]);
    expect(prompt).toContain('ANALYSIS ONLY');
    expect(prompt).toContain('Do not execute commands');
    expect(prompt).toContain('or run experiments');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('insufficient memory');
    expect(prompt).toContain('Matching event');
    expect(prompt).not.toContain('Unrelated event');
    expect(prompt).not.toContain('env-secret');
    expect(prompt).not.toContain('annotation-secret');
  });
  it('excludes Secret contents, bounds input and rejects unknown agent settings', () => {
    const secret = { ...pod, kind: 'Secret', raw: { data: { password: 'encoded-secret' }, stringData: { key: 'plaintext-secret' }, status: { password: 'status-secret', message: '😺'.repeat(50000) } } };
    const prompt = buildAnalysisPrompt(secret, null, []);
    expect(prompt).not.toContain('encoded-secret'); expect(prompt).not.toContain('plaintext-secret'); expect(prompt).not.toContain('status-secret');
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(65536);
    expect(normalizeAiAgent('opencode')).toBe('opencode'); expect(normalizeAiAgent('unknown')).toBe('codex');
  });
});
