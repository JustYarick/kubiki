// Monaco exports its bundled JSON tokenizer without a declaration file.
declare module 'monaco-editor/languages/features/json/tokenization.js' {
  export function createTokenizationSupport(supportComments: boolean): import('monaco-editor').languages.TokensProvider;
}
