// Bundled as the Monaco editor worker entry (main-thread shim imports the worker source).
//
// NOTE on the import path: monaco-editor 0.57's `exports` map has the pattern
//   "./*": "./esm/vs/*.js"
// so the correct (dev-server-compatible) specifier is "monaco-editor/editor/editor.worker.js"
// which resolves to ./esm/vs/editor/editor.worker.js. Writing the full fs path
// ("monaco-editor/esm/vs/...") breaks Vite's dev-time exports resolution.
import 'monaco-editor/editor/editor.worker.js';
