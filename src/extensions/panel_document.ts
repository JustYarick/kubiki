export function sandboxDocument(html: string): string {
  // srcdoc inherits the desktop CSP. Authorize inline bundles with the document's
  // runtime nonce, while retaining a separate policy that forbids external scripts.
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="kubiki-panel-nonce"]')?.content;
  if (nonce && nonce !== '__TAURI_SCRIPT_NONCE__') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const script of parsed.querySelectorAll('script')) {
      script.removeAttribute('nonce');
      if (!script.hasAttribute('src')) script.setAttribute('nonce', nonce);
    }
    html = parsed.documentElement.outerHTML;
  }
  // This policy precedes publisher content. Never add the parent nonce here:
  // unsafe-inline allows bundles, while external scripts remain forbidden even
  // if panel code copies its nonce onto a dynamically created script element.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${html}`;
}
