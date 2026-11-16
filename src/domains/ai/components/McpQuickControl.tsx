import { useEffect, useState } from 'react';
import { Check, Copy, Pencil, Plug, Settings2 } from 'lucide-react';
import { Popover } from '../../../components/ui/Dropdown';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { Input } from '../../../components/ui/Input';
import { useClusterStore } from '../../../state/cluster_store';
import { useUiStore } from '../../../state/ui_store';
import { namespaceScopeLabel } from '../../../core/resources/namespace_scope';
import { cx } from '../../../core/utils/cx';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import {
  ensureMcpProfiles,
  resolveEffectiveMcpPolicy,
  summarizeMcpPolicy,
  updateAiMcpSettings,
  type McpHttpStatus,
} from '../types';

export function McpQuickControl() {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const { currentContext, selectedNamespace, isConnected } = useClusterStore();
  const [httpStatus, setHttpStatus] = useState<McpHttpStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const storePort = settings.mcpServer?.port ?? 3847;
  const [portDraft, setPortDraft] = useState(String(storePort));
  const [portError, setPortError] = useState('');

  useEffect(() => {
    setPortDraft(String(storePort));
    setPortError('');
  }, [storePort]);

  const { profiles, activeId: storeActiveId, activeProfile: storeActiveProfile } = ensureMcpProfiles(settings);
  const storeMcpEnabled = Boolean(settings.mcpServer?.enabled);

  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);

  useEffect(() => { setOptimisticEnabled(null); }, [storeMcpEnabled]);
  useEffect(() => { setOptimisticActiveId(null); }, [storeActiveId]);

  const mcpEnabled = optimisticEnabled ?? storeMcpEnabled;
  const activeId = optimisticActiveId ?? storeActiveId;
  const activeProfile = profiles.find(p => p.id === activeId) ?? storeActiveProfile;
  const effectiveSettings = {
    ...settings,
    activeMcpProfileId: activeId,
    mcpServer: { enabled: mcpEnabled, port: settings.mcpServer?.port ?? 3847, ...settings.mcpServer },
  };
  const effectivePolicy = resolveEffectiveMcpPolicy(effectiveSettings, activeProfile);
  const summary = summarizeMcpPolicy(effectivePolicy);
  const mcpPort = httpStatus?.port ?? settings.mcpServer?.port ?? 3847;
  const mcpUrl = httpStatus?.url ?? `http://127.0.0.1:${mcpPort}/mcp`;
  const hasError = Boolean(httpStatus?.error);

  useEffect(() => {
    if (!desktopAiAvailable()) return;
    let cancelled = false;
    void agentTransport
      .mcpHttpStatus(false)
      .then(status => {
        if (!cancelled) setHttpStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings.mcpServer?.enabled, settings.mcpServer?.port, settings.mcpServer?.requireAuth]);

  async function savePatch(patch: Parameters<typeof updateAiMcpSettings>[1]) {
    if (!desktopAiAvailable()) return;
    if (patch.mcpServer?.enabled !== undefined) setOptimisticEnabled(patch.mcpServer.enabled);
    if (patch.activeProfileId !== undefined) setOptimisticActiveId(patch.activeProfileId);
    const current = useAiStore.getState().settings;
    const next = updateAiMcpSettings(current, patch);
    try {
      await useAiStore.getState().save(next);
      if (patch.mcpServer) {
        try {
          setHttpStatus(await agentTransport.mcpHttpStatus(false));
        } catch {
          /* ignore browser preview */
        }
      }
    } catch {
      setOptimisticEnabled(null);
      setOptimisticActiveId(null);
    }
  }

  async function applyPort() {
    if (!desktopAiAvailable()) return;
    const parsed = Number(portDraft);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setPortError('Port must be 1024–65535');
      return;
    }
    setPortError('');
    try {
      const current = useAiStore.getState().settings;
      await useAiStore.getState().save(updateAiMcpSettings(current, { mcpServer: { port: parsed } }));
      try {
        setHttpStatus(await agentTransport.mcpHttpStatus(false));
      } catch {
        /* ignore browser preview */
      }
    } catch (e) {
      setPortError(agentError(e));
    }
  }

  function badgeClasses(isReadOnly: boolean) {
    return isReadOnly
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
      : 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  }

  const writesTooltip = summary.isReadOnly
    ? 'Read-only (no write tools enabled)'
    : `Writes enabled: ${summary.allowedWrites.join(', ')}`;

  const title = mcpEnabled
    ? `Desktop MCP server listening on ${mcpUrl} · Profile: ${activeProfile.name} · ${writesTooltip}`
    : `Desktop MCP HTTP server is off · Profile: ${activeProfile.name} · ${writesTooltip}`;

  return (
    <Popover
      align="end"
      width={316}
      trigger={({ open }) => (
        <button
          type="button"
          aria-label="MCP Control"
          title={title}
          className={cx(
            'app-titlebar-mcp flex items-center gap-1.5 h-[var(--control-h-md)] px-2 rounded-[var(--radius-sm)] text-[length:var(--font-size-sm)] border transition-colors shrink-0',
            open
              ? 'bg-[var(--bg-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]'
              : 'bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <span
            className={cx(
              'w-1.5 h-1.5 rounded-full shrink-0',
              hasError
                ? 'bg-[var(--status-danger)]'
                : mcpEnabled
                  ? 'bg-[var(--status-ok)]'
                  : 'bg-[var(--text-muted)]',
            )}
          />
          <Plug
            size="calc(12px * var(--ui-factor))"
            className={mcpEnabled ? 'text-[var(--status-ok)] shrink-0' : 'shrink-0'}
          />
          <span className="font-medium hidden md:inline">
            {mcpEnabled ? 'MCP' : 'MCP off'}
          </span>
          <span className="truncate max-w-[92px] text-[length:calc(10px*var(--ui-factor))] hidden md:inline text-[var(--text-primary)]">
            {activeProfile.name}
          </span>
          <span
            className={cx(
              'px-1 py-0 rounded border font-mono font-semibold text-[length:calc(9px*var(--ui-factor))] leading-[1.35] shrink-0',
              badgeClasses(summary.isReadOnly),
            )}
          >
            {summary.isReadOnly ? 'RO' : 'RW'}
          </span>
        </button>
      )}
    >
      {close => (
        <div className="p-2.5 flex flex-col gap-2.5 text-xs">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border-subtle)]">
            <div className="min-w-0">
              <div className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <span>Kubiki MCP Server</span>
                <span
                  className={cx(
                    'px-1.5 py-0.5 rounded text-[10px] font-mono border',
                    badgeClasses(summary.isReadOnly),
                  )}
                >
                  {summary.isReadOnly ? 'RO' : 'RW'} · {summary.activeToolCount}/{summary.totalToolCount}
                </span>
              </div>
              <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                {isConnected && currentContext
                  ? `${currentContext} / ${namespaceScopeLabel(selectedNamespace)}`
                  : 'No cluster selected'}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <CheckboxRow
                label="Desktop HTTP MCP"
                checked={mcpEnabled}
                disabled={saving || !desktopAiAvailable()}
                onChange={e => void savePatch({ mcpServer: { enabled: e.target.checked } })}
              />
              <form
                className="flex items-center gap-1 shrink-0"
                onSubmit={e => {
                  e.preventDefault();
                  void applyPort();
                }}
              >
                <Input
                  aria-label="MCP port"
                  size="sm"
                  type="number"
                  min={1024}
                  max={65535}
                  className="w-[76px] [&_input]:font-mono [&_input]:tabular-nums [&_input]:[appearance:textfield] [&_input::-webkit-inner-spin-button]:hidden [&_input::-webkit-outer-spin-button]:hidden"
                  value={portDraft}
                  disabled={saving || !desktopAiAvailable()}
                  onChange={e => {
                    setPortError('');
                    setPortDraft(e.target.value);
                  }}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={saving || !desktopAiAvailable() || Number(portDraft) === mcpPort}
                  title="Apply HTTP MCP port"
                >
                  Apply
                </Button>
              </form>
            </div>
            {portError && (
              <p role="alert" className="text-[11px] text-[var(--status-danger)] m-0">
                {portError}
              </p>
            )}

            {mcpEnabled && (
              <div className="flex items-center justify-between gap-1.5 px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                <code className="text-[10.5px] font-mono text-[var(--text-secondary)] truncate select-all">
                  {mcpUrl}
                </code>
                <button
                  type="button"
                  aria-label="Copy MCP URL"
                  className="text-[10.5px] text-[var(--accent)] hover:underline shrink-0 flex items-center gap-1"
                  onClick={() => {
                    void navigator.clipboard.writeText(mcpUrl).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }).catch(() => {});
                  }}
                >
                  <Copy size={11} aria-hidden="true" />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            {httpStatus?.error && (
              <p role="alert" className="text-[11px] text-[var(--status-danger)] m-0">
                {httpStatus.error}
              </p>
            )}
          </div>

          <div className="pt-2 border-t border-[var(--border-subtle)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-[10.5px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                MCP Profile
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Edit MCP profiles"
                title="Create, rename, or customize MCP profiles"
                onClick={() => {
                  close();
                  useUiStore.getState().setSettingsOpen(true, 'ai.mcp.profiles');
                }}
              >
                <Pencil size={11} aria-hidden="true" />
                Edit profiles
              </Button>
            </div>
            <div className="flex flex-col gap-1" role="radiogroup" aria-label="Active MCP profile">
              {profiles.map(profile => {
                const eff = resolveEffectiveMcpPolicy(effectiveSettings, profile);
                const s = summarizeMcpPolicy(eff);
                const selected = profile.id === activeId;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={saving || !desktopAiAvailable()}
                    onClick={() => void savePatch({ activeProfileId: profile.id })}
                    className={cx(
                      'flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left border transition-colors',
                      selected
                        ? 'bg-[var(--accent-subtle,rgba(59,130,246,0.12))] border-[var(--accent)] text-[var(--text-primary)]'
                        : 'bg-transparent border-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]',
                    )}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Check
                        size={12}
                        className={selected ? 'text-[var(--accent)] shrink-0' : 'opacity-0 shrink-0'}
                        aria-hidden="true"
                      />
                      <span className="truncate font-medium">{profile.name}</span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">
                        {s.activeToolCount}/{s.totalToolCount}
                      </span>
                      <span
                        className={cx(
                          'px-1 py-0 rounded border font-mono text-[10px] font-semibold',
                          badgeClasses(s.isReadOnly),
                        )}
                      >
                        {s.isReadOnly ? 'RO' : 'RW'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {activeProfile.inheritShared && summary.isReadOnly && (
              <p className="text-[10.5px] text-[var(--text-muted)] px-1 m-0">
                {activeProfile.name} inherits Shared Permissions (currently 0 writes saved). Enable changes in Permissions…
              </p>
            )}
          </div>

          <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              onClick={() => {
                close();
                useUiStore.getState().setSettingsOpen(true, 'ai.mcp');
              }}
            >
              <Settings2 size={12} aria-hidden="true" />
              MCP Settings…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              onClick={() => {
                close();
                useUiStore.getState().setSettingsOpen(true, 'ai.access');
              }}
            >
              Permissions…
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
