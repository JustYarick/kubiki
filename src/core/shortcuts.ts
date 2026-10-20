/** Render existing cross-platform bindings for the current desktop OS. */
export function shortcutLabel(label: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  const modifier = /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl+';
  return label.replace(/Ctrl\/⌘\s*/g, modifier).replace(/⌘\s*/g, modifier);
}
