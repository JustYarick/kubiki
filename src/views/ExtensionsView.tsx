import { useEffect, useRef, useState } from 'react';
import { Package, RefreshCw } from 'lucide-react';
import {
  extensionRequest,
  desktopExtensions,
  type ExtensionPreview,
  type InstalledExtension,
} from '../providers/extensions';
import { refreshExtensions, useExtensions } from '../extensions/registry';
import { openWorkspacePanel, usePanelRegistry } from '../core/workspace_panels';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { cx } from '../core/utils/cx';
export function ExtensionsView() {
  const { installed, error: loadError, loading } = useExtensions();
  const [query, setQuery] = useState('');
  const [section, setSection] = useState('catalog');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [preview, setPreview] = useState<ExtensionPreview | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<InstalledExtension | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (desktopExtensions()) void refreshExtensions();
    return () => abort.current?.abort();
  }, []);
  const run = async (
    label: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(label);
    setError('');
    try {
      await operation(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setBusy('');
      }
    }
  };
  const act = (method: string, entry: InstalledExtension, extra = {}) =>
    void run(`${method}…`, async (signal) => {
      await extensionRequest(
        method,
        { id: entry.manifest.id, ...extra },
        signal,
      );
      await refreshExtensions();
    });
  const filtered = installed.filter(
    (entry) =>
      (section !== 'updates' || entry.origin.type === 'github') &&
      `${entry.manifest.name} ${entry.manifest.description} ${entry.manifest.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const entry =
    installed.find((e) => e.manifest.id === selected) ?? filtered[0];
  const inputClass =
    'rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs min-w-0';
  return (
    <div
      data-testid="extensions-manager"
      className="flex-1 min-h-0 overflow-auto p-4 text-xs"
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Package size={20} />
        <h1 className="text-base font-semibold flex-1">Extensions</h1>
        <Button
          disabled={!!busy || !desktopExtensions()}
          onClick={() => {
            setPreview(null);
            setInstallOpen(true);
            setError('');
          }}
        >
          Install from GitHub
        </Button>
        <label className={cx(inputClass, 'cursor-pointer')}>
          Install local package
          <input
            type="file"
            accept=".kubiki-extension"
            className="sr-only"
            disabled={!!busy || !desktopExtensions()}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void run('Reading and validating package…', async (signal) => {
                if (file.size > 20 * 1024 * 1024)
                  throw new Error('Package exceeds 20 MiB');
                const bytes = new Uint8Array(await file.arrayBuffer());
                let raw = '';
                for (let i = 0; i < bytes.length; i += 32768)
                  raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
                setPreview(
                  await extensionRequest(
                    'inspect.file',
                    { data: btoa(raw) },
                    signal,
                  ),
                );
                setInstallOpen(true);
              });
            }}
          />
        </label>
        <Button
          aria-label="Refresh extensions"
          disabled={loading}
          onClick={() => void refreshExtensions()}
        >
          <RefreshCw size={13} />
        </Button>
      </div>
      {!desktopExtensions() && (
        <p
          role="status"
          className="p-3 mb-3 rounded border border-[var(--border-default)]"
        >
          Extensions run in the desktop application. Use Kubiki desktop to
          install packages and connect to Redis.
        </p>
      )}
      <div
        role="tablist"
        aria-label="Extension sections"
        className="flex gap-2 mb-3"
      >
        {[
          ['catalog', 'Catalog'],
          ['installed', 'Installed'],
          ['updates', 'Updates'],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={section === id}
            className={cx(
              'px-3 py-2 rounded',
              section === id && 'bg-[var(--bg-hover)]',
            )}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 mb-3">
        Search extensions
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={inputClass}
          placeholder="Name, description or extension ID"
        />
      </label>
      {(error || loadError) && (
        <p
          role="alert"
          className="mb-3 text-[var(--status-danger)] break-words"
        >
          {error || loadError}
        </p>
      )}
      {busy && (
        <div role="status" className="mb-3 flex gap-3 items-center">
          <span>{busy}</span>
          <Button
            onClick={() => {
              abort.current?.abort();
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {section === 'updates' && (
        <p className="mb-3 text-[var(--text-secondary)]">
          Select an extension and check its published release. Updates are
          reviewed before installation.
        </p>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)] gap-4">
        <div role="list" aria-label="Extensions" className="space-y-2">
          {filtered.map((item) => (
            <div key={item.manifest.id} role="listitem">
              <button
                onClick={() => {
                  setSelected(item.manifest.id);
                  setLogs(null);
                }}
                className={cx(
                  'w-full text-left p-3 rounded border border-[var(--border-default)]',
                  entry?.manifest.id === item.manifest.id &&
                    'bg-[var(--bg-hover)]',
                )}
              >
                <span className="font-semibold">{item.manifest.name}</span>
                <span className="ml-2 text-[var(--text-muted)]">
                  {item.version}
                </span>
                <p className="mt-1 break-words text-[var(--text-secondary)]">
                  {item.manifest.description}
                </p>
                <p className="mt-2">
                  {item.origin.type === 'builtin'
                    ? 'Built-in · Official'
                    : item.origin.type === 'github'
                      ? `Community · ${item.origin.repo}`
                      : 'Local package'}{' '}
                  · {item.status}
                </p>
              </button>
            </div>
          ))}
          {!filtered.length && (
            <p role="status" className="text-[var(--text-muted)]">
              {loading
                ? 'Loading extensions…'
                : desktopExtensions()
                  ? 'No extensions in this view.'
                  : 'The built-in catalog is available in Kubiki desktop.'}
            </p>
          )}
        </div>
        {entry && (
          <section
            aria-label="Extension details"
            className="min-w-0 border border-[var(--border-default)] rounded p-4"
          >
            <h2 className="text-sm font-semibold mb-2">
              {entry.manifest.name}
            </h2>
            <p className="mb-3 break-words">{entry.manifest.description}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 mb-4">
              <dt>ID</dt>
              <dd className="break-all font-mono">{entry.manifest.id}</dd>
              <dt>Version</dt>
              <dd>{entry.version}</dd>
              <dt>Host API</dt>
              <dd>{entry.manifest.hostApi}</dd>
              <dt>Source</dt>
              <dd className="break-all">
                {entry.origin.repo ?? entry.origin.type}
              </dd>
              <dt>Integrations</dt>
              <dd>
                {entry.manifest.requestedCapabilities.join(', ') || 'None'}
              </dd>
            </dl>
            <p className="text-[var(--text-secondary)] mb-4">
              Extensions execute local code with your OS user privileges.
              Install packages from publishers you trust.
            </p>
            {entry.error && (
              <p
                role="alert"
                className="text-[var(--status-danger)] mb-3 break-words"
              >
                {entry.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {entry.enabled && (
                <Button
                  onClick={() => {
                    const p = usePanelRegistry
                      .getState()
                      .panels.find(
                        (p) =>
                          p.id ===
                          `${entry.manifest.id}.${entry.manifest.contributes.panels[0].id}`,
                      );
                    if (p) openWorkspacePanel(p);
                  }}
                >
                  Open
                </Button>
              )}
              <Button
                disabled={!!busy}
                onClick={() =>
                  act('enable', entry, { enabled: !entry.enabled })
                }
              >
                {entry.enabled ? 'Disable' : 'Enable'}
              </Button>
              {entry.enabled && (
                <Button disabled={!!busy} onClick={() => act('restart', entry)}>
                  Restart
                </Button>
              )}
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run('Loading logs…', async (signal) => {
                    setLogs(
                      await extensionRequest(
                        'logs',
                        { id: entry.manifest.id },
                        signal,
                      ),
                    );
                  })
                }
              >
                View logs
              </Button>
              {entry.previous && (
                <Button
                  disabled={!!busy}
                  onClick={() => act('rollback', entry)}
                >
                  Roll back to {entry.previous}
                </Button>
              )}
              {entry.origin.type === 'github' && (
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    setUrl(`https://github.com/${entry.origin.repo}`);
                    setInstallOpen(true);
                    setPreview(null);
                  }}
                >
                  Check update
                </Button>
              )}
              {entry.origin.type !== 'builtin' && (
                <Button
                  variant="danger"
                  disabled={!!busy}
                  onClick={() => setConfirm(entry)}
                >
                  Uninstall
                </Button>
              )}
            </div>
            {logs && (
              <pre
                aria-label="Extension logs"
                className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono"
              >
                {logs.join('\n') || 'No log output.'}
              </pre>
            )}
          </section>
        )}
      </div>
      <Modal
        open={installOpen}
        onClose={() => {
          if (!busy) setInstallOpen(false);
          else abort.current?.abort();
        }}
        title="Install extension"
        width={650}
        footer={
          <>
            <Button disabled={!!busy} onClick={() => setInstallOpen(false)}>
              Cancel
            </Button>
            {preview && (
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run(
                    'Installing and activating extension…',
                    async (signal) => {
                      const id = await extensionRequest<string>(
                        'install',
                        { token: preview.token },
                        signal,
                      );
                      await refreshExtensions();
                      setSelected(id);
                      setInstallOpen(false);
                      setPreview(null);
                    },
                  )
                }
              >
                Install &amp; Enable
              </Button>
            )}
          </>
        }
      >
        {!preview ? (
          <>
            <label className="flex flex-col gap-1">
              GitHub repository or release URL
              <input
                className={inputClass}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/author/extension"
              />
            </label>
            <p className="my-3 text-[var(--text-secondary)]">
              The release must contain a prepared .kubiki-extension package.
              Checking downloads and validates it without running code.
            </p>
            <Button
              disabled={!!busy || !url}
              onClick={() =>
                void run(
                  'Downloading and validating release…',
                  async (signal) =>
                    setPreview(
                      await extensionRequest('inspect.github', { url }, signal),
                    ),
                )
              }
            >
              Check package
            </Button>
          </>
        ) : (
          <>
            <h3 className="font-semibold">
              {preview.manifest.name} · {preview.manifest.version}
            </h3>
            <p className="my-2">{preview.manifest.description}</p>
            <p className="break-all">
              Source: {preview.source.repo ?? preview.source.type}
              {preview.tag ? ` · ${preview.tag}` : ''}
            </p>
            <p className="my-2">
              Integrations: {preview.manifest.requestedCapabilities.join(', ')}
            </p>
            <p className="text-[var(--status-warn)]">
              This package can run local code with your OS user privileges.
            </p>
            <p className="mt-2 break-all font-mono text-[var(--text-muted)]">
              SHA-256: {preview.digest}
            </p>
            <p className="mt-2 text-[var(--text-secondary)]">
              Checksum verifies downloaded bytes; it does not verify the
              publisher's identity.
            </p>
          </>
        )}
        {busy && (
          <p role="status" className="mt-3">
            {busy}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-3 text-[var(--status-danger)] break-words"
          >
            {error}
          </p>
        )}
      </Modal>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Uninstall extension"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm) act('uninstall', confirm);
                setConfirm(null);
              }}
            >
              Uninstall
            </Button>
          </>
        }
      >
        <p>
          Uninstall {confirm?.manifest.name}? Its processes will stop. Saved
          extension settings remain available for reinstallation.
        </p>
      </Modal>
    </div>
  );
}
