import { Globe, Shield, ExternalLink, ArrowRight, Lock, Server } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';

interface IngressRulesBlockProps {
  item: ResourceItem;
  onNavigate?: (item: ResourceItem) => void;
}

interface IngressPathRule {
  host: string;
  path: string;
  pathType: string;
  serviceName?: string;
  servicePort?: string | number;
  hasTls: boolean;
  tlsSecretName?: string;
}

export function IngressRulesBlock({ item, onNavigate }: IngressRulesBlockProps) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const ingressClass = spec.ingressClassName ?? (item.metadata?.annotations as any)?.['kubernetes.io/ingress.class'] ?? item.ingressClass;
  const lbIngress: Array<{ ip?: string; hostname?: string }> = status.loadBalancer?.ingress ?? [];

  // Parse TLS configs
  const tlsConfigs: Array<{ hosts: string[]; secretName?: string }> = (spec.tls ?? []).map((t: any) => ({
    hosts: t.hosts ?? [],
    secretName: t.secretName,
  }));

  const isTlsHost = (host: string): { hasTls: boolean; secretName?: string } => {
    for (const t of tlsConfigs) {
      if (t.hosts.includes(host) || (!host && t.hosts.length === 0)) {
        return { hasTls: true, secretName: t.secretName };
      }
    }
    return { hasTls: false };
  };

  // Flatten rules
  const rulesList: IngressPathRule[] = [];
  const rules = spec.rules ?? [];

  for (const r of rules) {
    const host = r.host ?? '*';
    const { hasTls, secretName } = isTlsHost(host);
    const paths = r.http?.paths ?? [];

    if (paths.length === 0) {
      rulesList.push({
        host,
        path: '/',
        pathType: 'Prefix',
        hasTls,
        tlsSecretName: secretName,
      });
    } else {
      for (const p of paths) {
        const backend = p.backend ?? {};
        const service = backend.service ?? {};
        rulesList.push({
          host,
          path: p.path ?? '/',
          pathType: p.pathType ?? 'ImplementationSpecific',
          serviceName: service.name ?? backend.resource?.name,
          servicePort: service.port?.number ?? service.port?.name ?? backend.resource?.kind,
          hasTls,
          tlsSecretName: secretName,
        });
      }
    }
  }

  // Find linked services and secrets in store
  const findService = (serviceName?: string) => {
    if (!serviceName) return undefined;
    return [...resources.Service.values()].find(
      (s) => s.name === serviceName && (!item.namespace || s.namespace === item.namespace)
    );
  };

  const findSecret = (secretName?: string) => {
    if (!secretName) return undefined;
    return [...resources.Secret.values()].find(
      (s) => s.name === secretName && (!item.namespace || s.namespace === item.namespace)
    );
  };

  return (
    <section aria-label="Ingress rules and routing" className="details-section">
      <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">Routing Rules & TLS</span>
        </div>
        {ingressClass && (
          <span className="text-[length:calc(10px*var(--ui-factor))] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
            class: {ingressClass}
          </span>
        )}
      </div>

      <div className="p-2 space-y-3">
        {/* Load Balancer Endpoints */}
        {lbIngress.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--text-muted)]">LoadBalancer Endpoints:</span>
            {lbIngress.map((lb, idx) => (
              <span key={idx} className="font-mono px-2 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--accent)]">
                {lb.ip || lb.hostname}
              </span>
            ))}
          </div>
        )}

        {/* Rules Table */}
        {rulesList.length > 0 ? (
          <div className="border border-[var(--border-subtle)] rounded overflow-x-auto kubiki-scrollbar">
            <div className="grid grid-cols-[minmax(120px,1.5fr)_minmax(80px,1fr)_minmax(120px,1.5fr)_auto] gap-2 px-3 py-1.5 bg-[var(--bg-secondary)] text-[length:calc(10px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              <span>Host</span>
              <span>Path</span>
              <span>Backend Service</span>
              <span>Action</span>
            </div>
            <div className="divide-y divide-[var(--border-subtle)] bg-[var(--bg-canvas)]">
              {rulesList.map((r, i) => {
                const scheme = r.hasTls ? 'https' : 'http';
                const url = r.host !== '*' ? `${scheme}://${r.host}${r.path}` : undefined;
                const svcItem = findService(r.serviceName);

                return (
                  <div key={i} className="grid grid-cols-[minmax(120px,1.5fr)_minmax(80px,1fr)_minmax(120px,1.5fr)_auto] gap-2 items-center px-2 py-1 text-xs">
                    {/* Host */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {r.hasTls ? (
                        <span title="TLS Enabled" className="inline-flex">
                          <Lock size="calc(11px * var(--ui-factor))" className="text-emerald-400 shrink-0" />
                        </span>
                      ) : (
                        <Globe size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />
                      )}
                      <span className="font-mono truncate select-text" title={r.host}>
                        {r.host}
                      </span>
                    </div>

                    {/* Path */}
                    <div className="min-w-0">
                      <span className="font-mono text-[var(--accent)] select-text">{r.path}</span>
                      <span className="ml-1 text-[length:calc(9px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
                        ({r.pathType})
                      </span>
                    </div>

                    {/* Backend */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ArrowRight size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />
                      {svcItem && onNavigate ? (
                        <button
                          type="button"
                          onClick={() => onNavigate(svcItem)}
                          className="font-mono text-[var(--accent)] hover:underline truncate text-left"
                          title={`Navigate to Service ${svcItem.name}`}
                        >
                          {r.serviceName}
                          {r.servicePort !== undefined && `:${r.servicePort}`}
                        </button>
                      ) : (
                        <span className="font-mono text-[var(--text-secondary)] truncate">
                          {r.serviceName ? `${r.serviceName}${r.servicePort !== undefined ? `:${r.servicePort}` : ''}` : '—'}
                        </span>
                      )}
                    </div>

                    {/* Action */}
                    <div>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]"
                          title={`Open ${url}`}
                        >
                          <ExternalLink size="calc(10px * var(--ui-factor))" />
                          Open
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)] text-[length:calc(10px*var(--ui-factor))]">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-[var(--text-muted)] italic">No explicit host/path rules defined.</div>
        )}

        {/* Default Backend */}
        {spec.defaultBackend && (
          <div className="flex items-center gap-2 p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs">
            <Server size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)]" />
            <span className="text-[var(--text-muted)]">Default Backend:</span>
            <span className="font-mono text-[var(--text-primary)]">
              {spec.defaultBackend.service?.name ?? spec.defaultBackend.resource?.name}
              {spec.defaultBackend.service?.port?.number ? `:${spec.defaultBackend.service.port.number}` : ''}
            </span>
          </div>
        )}

        {/* TLS Certificates */}
        {tlsConfigs.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[length:calc(11px*var(--ui-factor))] font-semibold text-[var(--text-secondary)]">
              <Shield size="calc(12px * var(--ui-factor))" className="text-emerald-400" />
              <span>TLS Certificates</span>
            </div>
            <div className="space-y-1">
              {tlsConfigs.map((t, idx) => {
                const sec = findSecret(t.secretName);
                return (
                  <div key={idx} className="flex flex-wrap items-center justify-between gap-2 p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Lock size="calc(11px * var(--ui-factor))" className="text-emerald-400 shrink-0" />
                      <span className="text-[var(--text-muted)]">Secret:</span>
                      {sec && onNavigate ? (
                        <button
                          type="button"
                          onClick={() => onNavigate(sec)}
                          className="font-mono text-[var(--accent)] hover:underline truncate"
                        >
                          {t.secretName}
                        </button>
                      ) : (
                        <span className="font-mono text-[var(--text-primary)]">{t.secretName ?? '—'}</span>
                      )}
                    </div>
                    {t.hosts.length > 0 && (
                      <div className="flex flex-wrap gap-1 text-[length:calc(10px*var(--ui-factor))]">
                        {t.hosts.map((h) => (
                          <span key={h} className="font-mono px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                            {h}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
