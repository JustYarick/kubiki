import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// Bundle workers locally — no CDN dependency (desktop/offline-safe).
// Rolldown can't handle `?worker` on node_modules deep imports, so we point
// at a local shim module that re-imports the official ESM worker source.
const workerUrl = new URL('./editor_worker.ts', import.meta.url);
(globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker(workerUrl, { type: 'module' }),
};

loader.config({ monaco });

monaco.editor.defineTheme('kubiki-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'dfe1e5' },
    { token: 'comment', foreground: '6f737a', fontStyle: 'italic' },
    { token: 'string.key.yaml', foreground: '82aaff' },
    { token: 'string.value.yaml', foreground: 'a8c986' },
    { token: 'number', foreground: 'e5b742' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'delimiter', foreground: '9da0a8' },
  ],
  colors: {
    'editor.background': '#1e1f22',
    'editor.foreground': '#dfe1e5',
    'editorLineNumber.foreground': '#565a61',
    'editorLineNumber.activeForeground': '#9da0a8',
    'editor.selectionBackground': '#3574f044',
    'editor.inactiveSelectionBackground': '#3574f022',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorIndentGuide.background1': '#33363b',
    'editorIndentGuide.activeBackground1': '#4a4d54',
    'editorGutter.background': '#1e1f22',
    'editorWidget.background': '#313438',
    'editorWidget.border': '#393b40',
    'scrollbarSlider.background': '#3e424980',
    'scrollbarSlider.hoverBackground': '#50555eaa',
    'scrollbarSlider.activeBackground': '#50555ecc',
  },
});

export { monaco };
