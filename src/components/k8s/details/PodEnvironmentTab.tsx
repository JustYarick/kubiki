import { useState, useMemo, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Copy,
  Check,
  Search,
  AlertTriangle,
  FileText,
  KeyRound,
  ExternalLink,
  Layers,
  Columns,
} from 'lucide-react';
import type { ResourceItem } from '../../../types/k8s';
import { podContainers } from '../../../core/resources/containers';
import { resolveContainerEnv, findResourceInMap } from '../../../core/resources/pod_env';
import { useResourceStore } from '../../../state/resource_store';
import { useUiStore } from '../../../state/ui_store';
import { Button } from '../../ui/Button';
import { toast } from '../../../state/notifications_store';
import { ContainerSelect } from '../ContainerSelect';
import { cx } from '../../../core/utils/cx';

interface PodEnvironmentTabProps {
  item: ResourceItem;
  onNavigate?: (item: ResourceItem) => void;
}

export function PodEnvironmentTab({ item, onNavigate }: PodEnvironmentTabProps) {
  const density = useUiStore((s) => s.density);
  const isCompact = density === 'compact';

  const resources = useResourceStore((s) => s.resources);
  const containers = useMemo(() => podContainers(item), [item]);

  const [selectedContainer, setSelectedContainer] = useState<string>(() => {
    return containers[0]?.name ?? '';
  });

  // Keep selected container in sync if item changes
  useEffect(() => {
    if (!containers.some((c) => c.name === selectedContainer) && containers.length > 0) {
      setSelectedContainer(containers[0].name);
    }
  }, [containers, selectedContainer]);

  const [searchQuery, setSearchQuery] = useState('');
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [showSource, setShowSource] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('kubiki.pod_env.show_source');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const toggleSource = () => {
    setShowSource((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('kubiki.pod_env.show_source', String(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  const headerCellCls = cx(
    'font-medium text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]',
    isCompact ? 'py-1.5 px-2.5' : 'py-2 px-3'
  );
  const bodyCellCls = isCompact ? 'py-1 px-2.5' : 'py-1.5 px-3';

  // Auto-hide revealed secrets after 60 seconds (security standard)
  useEffect(() => {
    if (revealedSecrets.size === 0) return;
    const timer = setTimeout(() => {
      setRevealedSecrets(new Set());
      toast.info('Secret values masked after timeout');
    }, 60000);
    return () => clearTimeout(timer);
  }, [revealedSecrets]);

  const envData = useMemo(() => {
    return resolveContainerEnv(item, selectedContainer, {
      ConfigMap: resources.ConfigMap,
      Secret: resources.Secret,
    });
  }, [item, selectedContainer, resources.ConfigMap, resources.Secret]);

  const colWidths = useMemo(() => {
    const entries = envData.entries;
    if (!entries || entries.length === 0) {
      return showSource
        ? { namePct: 37, valuePct: 37, sourcePct: 26 }
        : { namePct: 50, valuePct: 50, sourcePct: 0 };
    }

    let maxN = 15;
    let maxV = 15;
    for (const e of entries) {
      if (e.name) maxN = Math.max(maxN, e.name.length);
      if (e.value) maxV = Math.max(maxV, e.value.length);
    }

    const ratio = maxV / maxN;

    if (!showSource) {
      let namePct = 50;
      // When values are roughly equal, columns are equal (50% / 50%).
      // If a value is significantly larger (ratio > 1.8 and > 50 chars), compress Name down to min 32%
      if (ratio > 1.8 && maxV > 50) {
        const factor = Math.min(1, (maxV - 45) / 100);
        namePct = Math.round(50 - factor * 18);
      } else if (maxN > maxV * 2 && maxN > 40) {
        namePct = 55;
      }
      return { namePct, valuePct: 100 - namePct, sourcePct: 0 };
    } else {
      // 3 columns: Source takes 26%, remaining 74% balanced between Name and Value
      const totalRemaining = 74;
      let namePct = Math.round(totalRemaining / 2); // 37%
      if (ratio > 1.8 && maxV > 50) {
        const factor = Math.min(1, (maxV - 45) / 100);
        namePct = Math.round(37 - factor * 10);
      }
      return { namePct, valuePct: totalRemaining - namePct, sourcePct: 26 };
    }
  }, [envData.entries, showSource]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return envData.entries;
    return envData.entries.filter((entry) => {
      return (
        entry.name.toLowerCase().includes(q) ||
        (entry.value && entry.value.toLowerCase().includes(q)) ||
        (entry.sourceName && entry.sourceName.toLowerCase().includes(q))
      );
    });
  }, [envData.entries, searchQuery]);

  const copyToClipboard = async (text: string, label: string, keyId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(keyId);
      toast.success(`Copied ${label}`);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const toggleSecret = (name: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllSecrets = () => {
    const allSecretNames = envData.entries.filter((e) => e.isSecret).map((e) => e.name);
    if (revealedSecrets.size > 0) {
      setRevealedSecrets(new Set());
    } else {
      setRevealedSecrets(new Set(allSecretNames));
    }
  };

  const exportDotEnv = async () => {
    const lines = envData.entries.map((entry) => {
      const val = entry.value ?? '';
      return `${entry.name}=${val.includes(' ') || val.includes('\n') ? JSON.stringify(val) : val}`;
    });
    await copyToClipboard(lines.join('\n'), `${envData.entries.length} variables as .env`, 'export-all');
  };

  const navigateToResource = (kind: 'ConfigMap' | 'Secret', name: string) => {
    const target = findResourceInMap(resources[kind], name, item.namespace);
    if (target && onNavigate) {
      onNavigate(target);
    } else {
      toast.info(`${kind}/${name} not loaded in local cache`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] overflow-hidden text-xs">
      {/* Top Controls Toolbar */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-secondary)]/30">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Container Selector Dropdown */}
          {containers.length > 0 && (
            <ContainerSelect
              containers={containers}
              value={selectedContainer}
              onChange={setSelectedContainer}
              headerLabel="Environment · all containers"
            />
          )}

          {/* Quick Reveal Toggle */}
          {envData.entries.some((e) => e.isSecret) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={toggleAllSecrets}
              className="gap-1.5 text-[11px] h-7"
            >
              {revealedSecrets.size > 0 ? <EyeOff size={13} /> : <Eye size={13} />}
              {revealedSecrets.size > 0 ? 'Hide Secrets' : 'Reveal All Secrets'}
            </Button>
          )}

          {/* Toggle Source Column */}
          {envData.entries.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={toggleSource}
              className="gap-1.5 text-[11px] h-7"
              title={showSource ? 'Hide Source column' : 'Show Source column'}
            >
              <Columns size={13} className={showSource ? 'text-[var(--accent-text)]' : 'text-[var(--text-muted)]'} />
              {showSource ? 'Hide Source' : 'Show Source'}
            </Button>
          )}

          {/* Export button */}
          {envData.entries.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={exportDotEnv}
              className="gap-1.5 text-[11px] h-7"
              title="Copy all environment variables formatted as .env file"
            >
              {copiedKey === 'export-all' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              Export .env
            </Button>
          )}
        </div>

        {/* Search input */}
        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search variables or sources..."
            className="w-full h-7 pl-8 pr-3 bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded text-[11px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
      </div>

      {/* Drift Warning Banner (if ConfigMap/Secret changed since Pod start) */}
      {envData.hasDrift && (
        <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 flex items-start gap-2 text-[10.5px]">
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-400" />
          <div className="flex-1">
            <span className="font-semibold">Configuration drift detected:</span> One or more ConfigMaps or Secrets referenced by this pod were modified after container start. The values displayed below represent the active Pod environment. Restart or rollout the workload to apply updated values.
          </div>
        </div>
      )}

      {/* Main Table Content */}
      <div className="flex-1 overflow-auto kubiki-scrollbar p-2.5">
        {filteredEntries.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[var(--text-muted)] gap-2">
            <Layers size={24} className="opacity-40" />
            <p>
              {searchQuery
                ? `No environment variables match "${searchQuery}"`
                : 'No environment variables configured for this container.'}
            </p>
          </div>
        ) : (
          <div className="border border-[var(--border-subtle)] rounded overflow-x-auto kubiki-scrollbar shadow-xs">
            <table className={cx('w-full border-collapse text-left text-xs font-mono', showSource ? 'min-w-[480px]' : 'min-w-full')}>
              <thead>
                <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                  <th
                    style={{ width: `${colWidths.namePct}%` }}
                    className={headerCellCls}
                  >
                    Name
                  </th>
                  <th
                    style={{ width: `${colWidths.valuePct}%` }}
                    className={headerCellCls}
                    title="Resolved value (current source) · Click to copy"
                  >
                    Value
                  </th>
                  {showSource && (
                    <th
                      style={{ width: `${colWidths.sourcePct}%` }}
                      className={headerCellCls}
                    >
                      Source
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {filteredEntries.map((entry) => {
                  const isMasked = entry.isSecret && !revealedSecrets.has(entry.name);
                  const isNameCopied = copiedKey === `name-${entry.name}`;
                  const isValCopied = copiedKey === `val-${entry.name}`;

                  return (
                    <tr
                      key={entry.name}
                      className="hover:bg-[var(--bg-hover)] transition-colors group"
                    >
                      {/* Name (Click to copy name) */}
                      <td
                        className={cx(bodyCellCls, 'font-semibold text-[var(--text-primary)] align-top break-all')}
                        title={
                          isNameCopied
                            ? 'Copied!'
                            : !showSource && entry.sourceName
                              ? `Source: ${entry.sourceType} (${entry.sourceName}) · Click to copy name`
                              : 'Click to copy name'
                        }
                      >
                        <div
                          onClick={() => copyToClipboard(entry.name, entry.name, `name-${entry.name}`)}
                          className="cursor-pointer inline-flex items-center gap-1.5 flex-wrap hover:text-[var(--accent-text)] text-[var(--text-primary)] transition-colors select-all"
                        >
                          {entry.drift && (
                            <span title={entry.drift.reason} onClick={(e) => e.stopPropagation()}>
                              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                            </span>
                          )}
                          <span className="break-all">{entry.name}</span>
                          {isNameCopied && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-sans font-normal text-emerald-400 shrink-0 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20">
                              <Check size={11} />
                              <span>Copied</span>
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Value (Click to copy) */}
                      <td className={cx(bodyCellCls, 'align-top break-all')}>
                        {isMasked ? (
                          <div className="inline-flex items-center gap-1.5 flex-wrap">
                            <span
                              onClick={() => copyToClipboard(entry.value ?? '', entry.name, `val-${entry.name}`)}
                              className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-secondary)] tracking-widest select-none font-sans text-xs transition-colors"
                              title={isValCopied ? 'Copied!' : 'Click to copy secret value'}
                            >
                              ••••••••••••
                            </span>
                            {isValCopied && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-sans text-emerald-400 shrink-0 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20">
                                <Check size={11} />
                                <span>Copied</span>
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSecret(entry.name);
                              }}
                              className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors cursor-pointer"
                              title="Reveal secret value"
                              aria-label="Reveal secret value"
                            >
                              <Eye size={12} />
                            </button>
                          </div>
                        ) : entry.value !== undefined ? (
                          <div>
                            <div className="inline-flex items-center gap-1.5 flex-wrap">
                              <span
                                onClick={() => copyToClipboard(entry.value ?? '', entry.name, `val-${entry.name}`)}
                                className="text-emerald-400 hover:text-emerald-300 transition-colors select-all cursor-pointer font-mono break-all"
                                title={isValCopied ? 'Copied!' : 'Click to copy value'}
                              >
                                {entry.value}
                              </span>
                              {isValCopied && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-sans text-emerald-400 shrink-0 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20">
                                  <Check size={11} />
                                  <span>Copied</span>
                                </span>
                              )}
                              {entry.isSecret && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSecret(entry.name);
                                  }}
                                  className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors cursor-pointer"
                                  title="Hide secret value"
                                  aria-label="Hide secret value"
                                >
                                  <EyeOff size={12} />
                                </button>
                              )}
                            </div>
                            {entry.drift && (
                              <div className="mt-0.5 text-[10px] text-amber-300 font-sans">
                                ↳ {entry.drift.reason}
                                {entry.drift.clusterValue !== undefined && entry.drift.clusterValue !== entry.value && (
                                  <span> · Cluster has: <span className="font-mono text-amber-200">"{entry.drift.clusterValue}"</span></span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[var(--text-muted)] italic text-[11px] font-sans">
                            (empty or unresolved)
                          </span>
                        )}
                      </td>

                      {/* Source Badge */}
                      {showSource && (
                        <td className={cx(bodyCellCls, 'align-top font-sans text-[11px]')}>
                          {entry.sourceType === 'direct' && (
                            <span className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)] text-[10.5px]">
                              Direct (spec)
                            </span>
                          )}
                          {entry.sourceType === 'configMap' && (
                            <button
                              onClick={() => entry.sourceName && navigateToResource('ConfigMap', entry.sourceName)}
                              className="inline-flex items-center max-w-full whitespace-nowrap gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 text-left transition-colors cursor-pointer group/src text-[10.5px]"
                              title={`ConfigMap: ${entry.sourceName}${entry.sourceKey ? ` > ${entry.sourceKey}` : ''}`}
                            >
                              <FileText size={11} className="shrink-0" />
                              <span className="truncate">
                                <span className="font-semibold text-blue-300">ConfigMap:</span> {entry.sourceName}
                              </span>
                              <ExternalLink size={10} className="shrink-0 opacity-60 group-hover/src:opacity-100" />
                            </button>
                          )}
                          {entry.sourceType === 'secret' && (
                            <button
                              onClick={() => entry.sourceName && navigateToResource('Secret', entry.sourceName)}
                              className="inline-flex items-center max-w-full whitespace-nowrap gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 text-left transition-colors cursor-pointer group/src text-[10.5px]"
                              title={`Secret: ${entry.sourceName}${entry.sourceKey ? ` > ${entry.sourceKey}` : ''}`}
                            >
                              <KeyRound size={11} className="shrink-0" />
                              <span className="truncate">
                                <span className="font-semibold text-amber-300">Secret:</span> {entry.sourceName}
                              </span>
                              <ExternalLink size={10} className="shrink-0 opacity-60 group-hover/src:opacity-100" />
                            </button>
                          )}
                          {entry.sourceType === 'field' && (
                            <span
                              className="inline-flex items-center max-w-full whitespace-nowrap px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10.5px]"
                              title={`FieldRef: ${entry.sourceName}`}
                            >
                              <span className="truncate">FieldRef: {entry.sourceName}</span>
                            </span>
                          )}
                          {entry.sourceType === 'resourceField' && (
                            <span
                              className="inline-flex items-center max-w-full whitespace-nowrap px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-[10.5px]"
                              title={`Resource: ${entry.sourceName}`}
                            >
                              <span className="truncate">Resource: {entry.sourceName}</span>
                            </span>
                          )}
                          {entry.sourceType === 'unknown' && (
                            <span className="text-[var(--text-muted)] text-[10px] truncate max-w-full block">
                              {JSON.stringify(entry.rawSource)}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
