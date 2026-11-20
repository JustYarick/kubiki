import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_URL_SCHEME = /^(https?:\/\/|mailto:)/i;

export function safeReleaseNotesUrl(url: string): string {
  const trimmed = url.trim();
  return SAFE_URL_SCHEME.test(trimmed) ? trimmed : '';
}

export default function ReleaseNotesMarkdown({
  notes,
  onOpenUrl,
}: {
  notes: string;
  onOpenUrl: (url: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const safe = href ? safeReleaseNotesUrl(href) : '';
      if (!safe) return <span>{children}</span>;
      return (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
              event.preventDefault();
              onOpenUrl(safe);
            }
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
  }), [onOpenUrl]);

  return (
    <div className="update-notes-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeReleaseNotesUrl}
        components={components}
      >
        {notes}
      </Markdown>
    </div>
  );
}
