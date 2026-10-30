import { describe, expect, it } from 'vitest';
import { getClusterTone, hashClusterName, CLUSTER_PALETTES } from '../../src/core/cluster_color';

describe('Cluster color hashing system', () => {
  it('deterministically hashes cluster names and produces consistent tones', () => {
    const toneA = getClusterTone('kubiki-demo');
    const toneB = getClusterTone('kubiki-demo');
    expect(toneA).toEqual(toneB);
    expect(CLUSTER_PALETTES).toContainEqual(toneA);

    // Case-insensitivity & whitespace trimming
    const toneC = getClusterTone('  KUBIKI-DEMO  ');
    expect(toneC).toEqual(toneA);
  });

  it('maps special cluster contexts like general and * correctly', () => {
    const generalTone = getClusterTone('general');
    expect(generalTone.id).toBe('general');
    expect(generalTone.color).toBe('var(--text-muted)');

    const emptyTone = getClusterTone(null);
    expect(emptyTone.id).toBe('general');

    const allTone = getClusterTone('*');
    expect(allTone.id).toBe('all');
    expect(allTone.color).toBe('var(--accent)');
  });

  it('distributes different cluster names across the palette', () => {
    const clusters = ['prod-us-east', 'staging-eu-west', 'dev-local', 'minikube', 'kind-test'];
    const tones = clusters.map(c => getClusterTone(c));
    // Verify each tone has non-empty color, bg, border, and dot
    for (const tone of tones) {
      expect(tone.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tone.bg).toContain('rgba');
      expect(tone.border).toContain('rgba');
      expect(tone.dot).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('computes 32-bit FNV-1a hash stably', () => {
    const h1 = hashClusterName('cluster-alpha');
    const h2 = hashClusterName('cluster-alpha');
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('number');
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });
});
