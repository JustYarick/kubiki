export type CodeLanguage = 'plaintext' | 'yaml' | 'json' | 'ini' | 'shell' | 'xml' | 'javascript' | 'markdown' | 'dockerfile';

/** Filename hints take precedence. Arbitrary scalar values remain plain text. */
export function codeLanguage(filename: string, value = ''): CodeLanguage {
  const name = filename.toLowerCase();
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (/\.(json|jsonc)$/.test(name) || /^\.(dockerconfigjson|dockercfg)$/.test(name)) return 'json';
  if (/\.(ini|properties|cfg)$/.test(name) || /^\.env(\.|$)/.test(name)) return 'ini';
  if (/\.(sh|bash|zsh)$/.test(name)) return 'shell';
  if (/\.(xml|svg)$/.test(name)) return 'xml';
  if (/\.(js|mjs|cjs)$/.test(name)) return 'javascript';
  if (/\.md$/.test(name)) return 'markdown';
  if (/(^|\/)dockerfile(\.|$)/.test(name)) return 'dockerfile';
  if (/^\s*[{[]/.test(value)) {
    try { JSON.parse(value); return 'json'; } catch { /* Keep unrecognized data verbatim. */ }
  }
  return 'plaintext';
}
