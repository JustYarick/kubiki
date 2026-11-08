import { describe, expect, it } from 'vitest';
import { splitSkillReferences } from '../../src/domains/ai/skill_catalog';

describe('skill references', () => {
  const installed = new Set(['cluster-debug', 'skill']);
  it('highlights exact installed names without styling shell variables or longer unknown names', () => {
    const text = 'Use $cluster-debug with $PATH, $cluster-debug-extra and prefix$skill.';
    const parts = splitSkillReferences(text, installed);
    expect(parts.filter(part => part.skill).map(part => part.text)).toEqual(['$cluster-debug']);
    expect(parts.map(part => part.text).join('')).toBe(text);
  });
  it('preserves multiline whitespace and offsets for the editable highlight mirror', () => {
    const text = '$skill\n\n  $cluster-debug\tend\n';
    const parts = splitSkillReferences(text, installed);
    expect(parts.map(part => part.text).join('')).toBe(text);
    expect(parts.filter(part => part.skill).map(part => part.text)).toEqual(['$skill', '$cluster-debug']);
  });
});
