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
} from 'lucide-react';
import type { ResourceItem } from '../../../types/k8s';
import { podContainers } from '../../../core/resources/containers';
import { resolveContainerEnv } from '../../../core/resources/pod_env';
import { useResourceStore } from '../../../state/resource_store';
import { IconButton, Button } from '../../ui/Button';
import { toast } from '../../../state/notifications_store';

interface PodEnvironmentTabProps {
  item: ResourceItem;
  onNavigate?: (item: ResourceItem) => void;
}

export function PodEnvironmentTab({ item, onNavigate }: PodEnvironmentTabProps) {
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
    const targetMap = resources[kind];
    const target = targetMap
      ? [...targetMap.values()].find((r) => r.name === name && (!item.namespace || r.namespace === item.namespace))
      : undefined;
    if (target && onNavigate) {
      onNavigate(target);
    } else {
      toast.info(`${kind}/${name} not loaded in local cache`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] overflow-hidden text-xs">
      {/* Top Controls Toolbar */}
      <div className="p-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--bg-secondary)]/30">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Container Selector Tabs / Dropdown */}
          <div className="flex items-center gap-1.5 bg-[var(--bg-secondary)] p-1 rounded border border-[var(--border-subtle)]">
            <span className="text-[10px] uppercase font-semibold text-[var(--text-muted)] px-1">Container:</span>
            {containers.map((c) => (
              <button
                key={c.name}
                onClick={() => setSelectedContainer(c.name)}
                className={`px-2 py-0.5 rounded font-mono text-[11px] transition-colors ${
                  selectedContainer === c.name
                    ? 'bg-[var(--accent-primary)] text-white font-medium shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {c.name}
                {c.role && c.role !== 'application' && (
                  <span className="ml-1 text-[9px] opacity-75">({c.role})</span>
                )}
              </button>
            ))}
          </div>

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
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search variables or sources..."
            className="w-full pl-8 pr-3 py-1 bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded text-[11px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
      </div>

      {/* Drift Warning Banner (if ConfigMap/Secret changed since Pod start) */}
      {envData.hasDrift && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 flex items-start gap-2 text-[11px]">
          <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-400" />
          <div className="flex-1">
            <span className="font-semibold">Configuration drift detected:</span> One or more ConfigMaps referenced by this pod were modified after container start. The values displayed below represent the active Pod environment. Restart or rollout the workload to apply new ConfigMap values.
          </div>
        </div>
      )}

      {/* Main Table Content */}
      <div className="flex-1 overflow-auto kubiki-scrollbar p-3">
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
            <table className="w-full min-w-[650px] border-collapse text-left text-xs font-mono">
              <thead>
                <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
                  <th className="py-2 px-3 w-[28%]">Name</th>
                  <th className="py-2 px-3 w-[38%]">Active Pod Value</th>
                  <th className="py-2 px-3 w-[26%]">Source</th>
                  <th className="py-2 px-2 text-right w-16">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {filteredEntries.map((entry) => {
                  const isMasked = entry.isSecret && !revealedSecrets.has(entry.name);
                  const isCopied = copiedKey === entry.name;

                  return (
                    <tr
                      key={entry.name}
                      className="hover:bg-[var(--bg-hover)] transition-colors group"
                    >
                      {/* Name */}
                      <td className="py-2 px-3 font-semibold text-[var(--text-primary)] align-top break-all select-all">
                        <div className="flex items-center gap-1.5">
                          {entry.drift && (
                            <span title={entry.drift.reason}>
                              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                            </span>
                          )}
                          <span>{entry.name}</span>
                        </div>
                      </td>

                      {/* Value */}
                      <td className="py-2 px-3 align-top break-all">
                        {isMasked ? (
                          <span className="text-[var(--text-muted)] tracking-widest select-none font-sans text-xs">
                            ••••••••••••
                          </span>
                        ) : entry.value !== undefined ? (
                          <div>
                            <span className="text-emerald-400 select-all">{entry.value}</span>
                            {entry.drift?.clusterValue !== undefined && entry.drift.clusterValue !== entry.value && (
                              <div className="mt-1 text-[10px] text-amber-300 font-sans">
                                ↳ Cluster ConfigMap has: <span className="font-mono text-amber-200">"{entry.drift.clusterValue}"</span>
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
                      <td className="py-2 px-3 align-top font-sans text-[11px]">
                        {entry.sourceType === 'direct' && (
                          <span className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                            Direct (spec)
                          </span>
                        )}
                        {entry.sourceType === 'configMap' && (
                          <button
                            onClick={() => entry.sourceName && navigateToResource('ConfigMap', entry.sourceName)}
                            className="inline-flex items-center max-w-full whitespace-nowrap gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 text-left transition-colors cursor-pointer group/src"
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
                            className="inline-flex items-center max-w-full whitespace-nowrap gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 text-left transition-colors cursor-pointer group/src"
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
                            className="inline-flex items-center max-w-full whitespace-nowrap px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20"
                            title={`FieldRef: ${entry.sourceName}`}
                          >
                            <span className="truncate">FieldRef: {entry.sourceName}</span>
                          </span>
                        )}
                        {entry.sourceType === 'resourceField' && (
                          <span
                            className="inline-flex items-center max-w-full whitespace-nowrap px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
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

                      {/* Actions */}
                      <td className="py-2 px-2 align-top text-right">
                        <div className="flex items-center justify-end gap-1">
                          {entry.isSecret && (
                            <IconButton
                              icon={isMasked ? Eye : EyeOff}
                              size="sm"
                              tooltip={isMasked ? 'Reveal secret value' : 'Hide secret value'}
                              onClick={() => toggleSecret(entry.name)}
                              aria-label={isMasked ? 'Reveal secret' : 'Hide secret'}
                            />
                          )}
                          <IconButton
                            icon={isCopied ? Check : Copy}
                            size="sm"
                            className={isCopied ? 'text-emerald-400' : ''}
                            tooltip={`Copy value for ${entry.name}`}
                            onClick={() => copyToClipboard(entry.value ?? '', entry.name, entry.name)}
                            aria-label={`Copy value for ${entry.name}`}
                          />
                        </div>
                      </td>
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
