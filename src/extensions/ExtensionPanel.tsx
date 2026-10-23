import { useEffect, useRef, useState } from 'react';
import { extensionRequest } from '../providers/extensions';
import { useUiStore } from '../state/ui_store';
import { toast } from '../state/notifications_store';
import { Button } from '../components/ui/Button';
import { ResourceLoading } from '../components/ui/ResourceLoading';
const TOKENS = [
  '--bg-canvas',
  '--bg-secondary',
  '--bg-hover',
  '--bg-overlay',
  '--border-default',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent',
  '--status-danger',
  '--status-warn',
  '--ui-factor',
  '--font-mono',
];
export function extensionTheme() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    TOKENS.map((key) => [key, style.getPropertyValue(key).trim()]),
  );
}
export function sandboxDocument(html: string): string {
  // CSP precedes every publisher-supplied element. Inline bundles only; no external
  // scripts, fetch, frames, forms or objects. The iframe has an opaque origin.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${html}`;
}
export function ExtensionPanel({
  extensionId,
  panelId,
  visible,
}: {
  extensionId: string;
  panelId: string;
  visible: boolean;
}) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const view = useRef('');
  const visibility = useRef(visible);
  visibility.current = visible;
  const uiScale = useUiStore((s) => s.uiScale);
  const requests = useRef(new Map<number, AbortController>());
  useEffect(() => {
    let closed = false;
    let closeNotifications: (() => void) | undefined;
    const currentView = crypto.randomUUID();
    view.current = currentView;
    setHtml('');
    setError('');
    void extensionRequest<string>('view.open', {
      id: extensionId,
      panel: panelId,
      view: currentView,
    })
      .then((content) => {
        if (closed) {
          void extensionRequest('view.close', { view: currentView }).catch(
            () => {},
          );
          return;
        }
        setHtml(sandboxDocument(content));
      })
      .catch((e) => {
        if (!closed) setError(e.message);
      });
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ extensionId: string; message: string }>(
          'extensions-notification',
          ({ payload }) => {
            if (payload.extensionId === extensionId)
              toast.info(payload.message);
          },
        ),
      )
      .then((close) => {
        if (closed) close();
        else closeNotifications = close;
      })
      .catch(() => {});
    return () => {
      closed = true;
      closeNotifications?.();
      port.current?.close();
      port.current = null;
      requests.current.forEach((abort) => abort.abort());
      requests.current.clear();
      void extensionRequest('view.close', { view: currentView }).catch(
        () => {},
      );
    };
  }, [extensionId, panelId, revision]);
  useEffect(() => {
    port.current?.postMessage({ type: 'visibility', visible });
  }, [visible]);
  useEffect(() => {
    port.current?.postMessage({ type: 'theme', tokens: extensionTheme() });
  }, [uiScale]);
  useEffect(() => {
    if (!visible) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const entries =
          await extensionRequest<
            { manifest: { id: string }; status: string; error: string | null }[]
          >('list');
        const entry = entries.find(
          (entry) => entry.manifest.id === extensionId,
        );
        if (!closed && entry?.status === 'failed')
          setError(entry.error ?? 'Extension stopped. Restart it to continue.');
      } catch {}
      if (!closed) timer = setTimeout(() => void check(), 3000);
    };
    timer = setTimeout(() => void check(), 3000);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [extensionId, visible, revision]);
  const attach = () => {
    port.current?.close();
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = async ({ data }) => {
      if (data?.type === 'cancel' && Number.isSafeInteger(data.id)) {
        requests.current.get(data.id)?.abort();
        return;
      }
      if (
        !Number.isSafeInteger(data?.id) ||
        data.id < 1 ||
        requests.current.has(data.id)
      )
        return;
      const reply = (message: unknown) => {
        try {
          channel.port1.postMessage(message);
        } catch {}
      };
      let size: number;
      try {
        size = JSON.stringify(data).length;
      } catch {
        reply({ id: data.id, error: 'Invalid panel message' });
        return;
      }
      if (requests.current.size >= 32 || size > 512 * 1024) {
        reply({ id: data.id, error: 'Too many or oversized panel requests' });
        return;
      }
      const abort = new AbortController();
      requests.current.set(data.id, abort);
      try {
        let result: unknown;
        if (data.method === 'call' && typeof data.params?.method === 'string')
          result = await extensionRequest(
            'call',
            {
              id: extensionId,
              method: data.params.method,
              params: data.params.params,
            },
            abort.signal,
          );
        else if (
          ['settings.get', 'settings.set', 'notify'].includes(data.method)
        )
          result = await extensionRequest(
            'service',
            { id: extensionId, method: data.method, params: data.params },
            abort.signal,
          );
        else throw new Error('This operation is not exposed to panels');
        reply({ id: data.id, result });
      } catch (e) {
        reply({
          id: data.id,
          error: e instanceof Error ? e.message : 'Extension failed',
        });
      } finally {
        requests.current.delete(data.id);
      }
    };
    frame.current?.contentWindow?.postMessage(
      {
        type: 'kubiki:init',
        theme: extensionTheme(),
        visible: visibility.current,
      },
      '*',
      [channel.port2],
    );
  };
  if (error)
    return (
      <div role="alert" className="p-4 text-sm">
        <p className="mb-3 break-words">{error}</p>
        <Button
          onClick={() => {
            void extensionRequest('restart', { id: extensionId })
              .then(() => setRevision((n) => n + 1))
              .catch((e) => setError(e.message));
          }}
        >
          Restart extension
        </Button>
      </div>
    );
  if (!html) return <ResourceLoading label="Activating extension…" />;
  return (
    <iframe
      ref={frame}
      title={`${extensionId} panel`}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcDoc={html}
      onLoad={attach}
      className="w-full h-full flex-1 min-h-0 border-0"
    />
  );
}
