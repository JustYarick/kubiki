import { expect, it } from 'vitest';
import { shortcutLabel } from '../../src/core/shortcuts';
it('renders OS-specific modifier labels without changing plain keys', () => {
  expect(shortcutLabel('Hide Explorer (⌘B)', 'Linux x86_64')).toBe('Hide Explorer (Ctrl+B)');
  expect(shortcutLabel('Ctrl/⌘ K', 'Win32')).toBe('Ctrl+K');
  expect(shortcutLabel('Ctrl/⌘ K', 'MacIntel')).toBe('⌘K');
  expect(shortcutLabel('⌘W', 'MacIntel')).toBe('⌘W');
  expect(shortcutLabel('Shift+F10', 'Linux')).toBe('Shift+F10');
});
