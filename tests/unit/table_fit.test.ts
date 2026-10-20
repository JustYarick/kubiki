import { describe, expect, it } from 'vitest';
import { fitTableColumns } from '../../src/core/resources/table_fit';
const defaults = { __index: 38, name: 240, namespace: 130, status: 132, age: 80 };
const ids = Object.keys(defaults);
describe('initial table fit', () => {
  it('fills the current pane proportionally and recalculates for a different pane', () => {
    for (const width of [600, 1000, 1400]) {
      const fitted = fitTableColumns(ids, width, defaults);
      expect(Object.values(fitted).reduce((sum, value) => sum + value, 0)).toBeCloseTo(width, 1);
      expect(fitted.__index).toBe(38); expect(fitted.name).toBeGreaterThan(fitted.age);
    }
  });
  it('preserves exact manual widths and fits remaining columns without unstable constraint allocation', () => {
    const fitted = fitTableColumns(ids, 900, defaults, { name: 56, age: 300 });
    expect(fitted.name).toBe(56); expect(fitted.age).toBe(300);
    expect(Object.values(fitted).reduce((sum, value) => sum + value, 0)).toBeCloseTo(900, 1);
    const capped = fitTableColumns(['a', 'b', 'c'], 1300, { a: 1000, b: 1000, c: 1 });
    expect(capped).toEqual({ a: 520, b: 520, c: 260 });
  });
  it('keeps readable minimums in a narrow pane and caps widths in a large one', () => {
    const narrow = fitTableColumns(ids, 200, defaults);
    expect(narrow.name).toBe(120); expect(narrow.namespace).toBe(90);
    expect(Object.values(narrow).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(200);
    expect(Object.values(fitTableColumns(ids, 5000, defaults)).every(value => value <= 520)).toBe(true);
  });
});
