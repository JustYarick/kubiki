import { describe, expect, it } from 'vitest';
import { compareCreation, issuePriority } from '../../src/core/resources/resource_sort';
import type { ResourceItem } from '../../src/types/k8s';

function item(name: string, creationTimestamp?: string): ResourceItem { return { uid: name, name, kind: 'Pod', apiVersion: 'v1', creationTimestamp }; }
describe('Resource list ordering', () => {
  it('orders by actual creation time across timezones and leaves unknown dates last in both directions', () => {
    const items = [item('invalid', 'invalid'), item('new', '2026-10-20T10:30:00+03:00'), item('missing'), item('old', '2026-10-20T07:00:00Z')];
    expect([...items].sort((a,b) => compareCreation(a,b,-1)).map((item)=>item.name)).toEqual(['new','old','invalid','missing']);
    expect([...items].sort((a,b) => compareCreation(a,b,1)).map((item)=>item.name)).toEqual(['old','new','invalid','missing']);
    expect(items[0].name).toBe('invalid');
  });
  it('places errors ahead of warnings and healthy resources', () => {
    expect(issuePriority([])).toBe(0);
    expect(issuePriority([{id:'warning',severity:'warning',summary:'Pending'}])).toBe(1);
    expect(issuePriority([{id:'error',severity:'error',summary:'CrashLoopBackOff'},{id:'warning',severity:'warning',summary:'Not ready'}])).toBe(2);
  });
});
