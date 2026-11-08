import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Terminal, Layers, ShieldCheck, Box, HardDrive, Cpu } from 'lucide-react';
import type { ResourceContainer } from '../../../../types/k8s';
import { ContainerStatusIcon } from '../../ContainerSelect';
import { canExecContainer, containerTone, CONTAINER_ROLE_LABEL } from '../../../../core/resources/containers';
import { IconButton } from '../../../ui/Button';
import { quantity, cpuText, memoryText } from '../../../../core/resources/quantities';

interface ContainerCardProps {
  container: ResourceContainer;
  spec?: any;
  status?: any;
  usage?: { cpu: number | null; memory: number | null; stale: boolean };
  onLogs?: (containerName: string) => void;
  onShell?: (containerName: string) => void;
}

export function ContainerCard({ container, spec = {}, status = {}, usage, onLogs, onShell }: ContainerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  // Extract container status and last state
  const cs = status;
  const stateObj = cs?.state ?? {};
  const stateKey = Object.keys(stateObj)[0] as 'running' | 'waiting' | 'terminated' | undefined;
  const stateData = stateKey ? stateObj[stateKey] : undefined;

  const lastStateObj = cs?.lastState ?? {};
  const lastStateKey = Object.keys(lastStateObj)[0] as 'running' | 'waiting' | 'terminated' | undefined;
  const lastStateData = lastStateKey ? lastStateObj[lastStateKey] : undefined;
  const isHealthyRunning = (container.ready || stateKey === 'running') && stateKey !== 'waiting' && stateKey !== 'terminated';

  const envs: any[] = spec.env ?? [];
  const mounts: any[] = spec.volumeMounts ?? [];
  const ports: any[] = spec.ports ?? [];
  const resources = spec.resources ?? {};
  const stateLabel = stateData?.reason ?? (stateKey === 'terminated' && stateData?.exitCode === 0 ? 'Completed' : stateKey ?? container.state ?? 'Unknown');

  const summary = (
    <div className="px-3 pb-2 pt-0.5 flex flex-col gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/20 text-xs">
      <div className="font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] break-all flex items-center gap-1.5">
        <Box aria-hidden="true" size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />
        <span>{container.image}</span>
        {spec.imagePullPolicy && (
          <span className="text-[10px] text-[var(--text-muted)]">({spec.imagePullPolicy})</span>
        )}
      </div>

      {/* Current State */}
      {stateData && (
        <div className="flex flex-wrap items-center gap-2 text-[length:calc(11px*var(--ui-factor))] mt-0.5">
          <span className="text-[var(--text-muted)]">State:</span>
          <span className="font-medium capitalize text-[var(--text-primary)]">{stateKey}</span>
          {stateData.reason && (
            <span className="text-amber-400 font-mono text-[10.5px]">[{stateData.reason}]</span>
          )}
          {stateData.exitCode !== undefined && (
            <span className="text-rose-400 font-mono text-[10.5px]">exit {stateData.exitCode}</span>
          )}
          {stateData.startedAt && (
            <span className="text-[var(--text-muted)] text-[10px]">
              started {new Date(stateData.startedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Last State (Only displayed as an alert banner if container is NOT currently running healthy) */}
      {lastStateData && !isHealthyRunning && (
        <div className="flex flex-wrap items-center gap-2 text-[length:calc(10.5px*var(--ui-factor))] text-rose-300 bg-rose-950/20 px-2 py-0.5 rounded border border-rose-500/20">
          <span className="font-semibold uppercase tracking-wider text-[10px]">Last State:</span>
          <span className="capitalize">{lastStateKey}</span>
          {lastStateData.reason && <span className="font-mono">[{lastStateData.reason}]</span>}
          {lastStateData.exitCode !== undefined && <span className="font-mono">Exit Code: {lastStateData.exitCode}</span>}
          {lastStateData.finishedAt && <span>at {new Date(lastStateData.finishedAt).toLocaleTimeString()}</span>}
        </div>
      )}
    </div>
  );

  return (
    <div className="container-card rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden" data-container-name={container.name} data-container-role={container.role ?? 'application'}>
      {/* Container Header */}
      <div className="container-card-header">
        <button type="button" className="container-card-toggle" aria-label={`Details for ${container.name}`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <ContainerStatusIcon container={container} />
          <span className="container-card-name">{container.name}</span>
          {container.role && container.role !== 'application' && <span className="container-card-role">{CONTAINER_ROLE_LABEL[container.role]}</span>}
        </button>
        <div className="container-card-meta">
          {!!usage && <span className="container-card-state" data-tone={containerTone(container)}>{stateLabel}{container.state === 'running' && ['application', 'sidecar'].includes(container.role ?? 'application') && !container.ready ? ' · Not ready' : ''}</span>}
          {cs?.restartCount !== undefined && <span className="container-card-restarts">{cs.restartCount} restarts</span>}
          {usage && <div className="container-card-usage" role="group" aria-label={`Usage for ${container.name}`}>
            <span title={usage.cpu === null ? 'No current CPU sample' : 'Measured CPU usage'}>CPU <b>{cpuText(usage.cpu)}</b></span>
            <span title={usage.memory === null ? 'No current RAM sample' : 'Measured memory usage'}>RAM <b>{memoryText(usage.memory)}</b></span>
            {usage.stale && <span className="container-card-stale" title="Metrics are stale or unavailable; these are the last observed values.">Last sample</span>}
          </div>}
        </div>
        <div className="container-card-actions">
          {onLogs && (
            <IconButton
              icon={FileText}
              size="sm"
              tooltip={`Logs for ${container.name}`}
              onClick={() => onLogs(container.name)}
              aria-label={`Logs for ${container.name}`}
            />
          )}
          {onShell && (
            <IconButton
              icon={Terminal}
              size="sm"
              disabled={!canExecContainer(container)}
              tooltip={canExecContainer(container) ? `Shell into ${container.name}` : 'Cannot exec into this container'}
              onClick={() => onShell(container.name)}
              aria-label={`Shell for ${container.name}`}
            />
          )}
        </div>
      </div>

      {!usage && summary}

      {/* Expanded Container Details */}
      <div id={detailsId} hidden={!expanded}>
        {expanded && <>
          {!!usage && summary}
          <div className="p-2 flex flex-col gap-3 bg-[var(--bg-canvas)] text-xs">
            {/* Ports */}
            {ports.length > 0 && (
              <div>
                <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Layers aria-hidden="true" size="calc(12px * var(--ui-factor))" /> Ports
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ports.map((p: any, idx: number) => (
                    <span key={idx} className="font-mono text-[length:calc(11px*var(--ui-factor))] px-2 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                      {p.name ? `${p.name}: ` : ''}{p.containerPort}/{p.protocol || 'TCP'}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Resources */}
            {(resources.requests || resources.limits) && (
              <div>
                <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Cpu aria-hidden="true" size="calc(12px * var(--ui-factor))" /> Resources
                </div>
                <div className="grid grid-cols-2 gap-2 text-[length:calc(11px*var(--ui-factor))] font-mono">
                  <div className="p-1.5 rounded bg-[var(--bg-secondary)]">
                    <div className="text-[10px] text-[var(--text-muted)] uppercase">Requests</div>
                    <div>CPU: {cpuText(quantity(resources.requests?.cpu))}</div>
                    <div>Mem: {memoryText(quantity(resources.requests?.memory))}</div>
                  </div>
                  <div className="p-1.5 rounded bg-[var(--bg-secondary)]">
                    <div className="text-[10px] text-[var(--text-muted)] uppercase">Limits</div>
                    <div>CPU: {cpuText(quantity(resources.limits?.cpu))}</div>
                    <div>Mem: {memoryText(quantity(resources.limits?.memory))}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Environment Variables */}
            {envs.length > 0 && (
              <div>
                <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                  Environment Variables ({envs.length})
                </div>
                <div className="max-h-48 overflow-y-auto kubiki-scrollbar space-y-1 font-mono text-[length:calc(10.5px*var(--ui-factor))]">
                  {envs.map((env: any, idx: number) => (
                    <div key={idx} className="p-1.5 rounded bg-[var(--bg-secondary)]/60 border border-[var(--border-subtle)] flex flex-wrap items-center gap-1.5">
                      <span className="text-[var(--text-primary)] font-semibold">{env.name}</span>
                      <span className="text-[var(--text-muted)]">=</span>
                      {env.value !== undefined ? (
                        <span className="text-emerald-400 break-all">{env.value}</span>
                      ) : env.valueFrom?.secretKeyRef ? (
                        <span className="text-amber-400 text-[10px] bg-amber-500/10 px-1 py-0.5 rounded">
                          Secret: {env.valueFrom.secretKeyRef.name} [{env.valueFrom.secretKeyRef.key}]
                        </span>
                      ) : env.valueFrom?.configMapKeyRef ? (
                        <span className="text-blue-400 text-[10px] bg-blue-500/10 px-1 py-0.5 rounded">
                          ConfigMap: {env.valueFrom.configMapKeyRef.name} [{env.valueFrom.configMapKeyRef.key}]
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)] text-[10px]">{JSON.stringify(env.valueFrom)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Mounts */}
            {mounts.length > 0 && (
              <div>
                <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <HardDrive aria-hidden="true" size="calc(12px * var(--ui-factor))" /> Volume Mounts ({mounts.length})
                </div>
                <div className="space-y-1 font-mono text-[length:calc(10.5px*var(--ui-factor))]">
                  {mounts.map((m: any, idx: number) => (
                    <div key={idx} className="p-1.5 rounded bg-[var(--bg-secondary)]/60 flex items-center justify-between gap-2">
                      <span className="text-[var(--text-primary)]">{m.mountPath}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {m.name} {m.readOnly ? '(ro)' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Probes */}
            {(spec.livenessProbe || spec.readinessProbe || spec.startupProbe) && (
              <div>
                <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <ShieldCheck aria-hidden="true" size="calc(12px * var(--ui-factor))" /> Probes
                </div>
                <div className="flex flex-wrap gap-2 text-[length:calc(10.5px*var(--ui-factor))]">
                  {spec.livenessProbe && (
                    <span className="p-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                      Liveness: {spec.livenessProbe.httpGet ? `HTTP ${spec.livenessProbe.httpGet.path}` : spec.livenessProbe.tcpSocket ? 'TCP' : 'Exec'}
                    </span>
                  )}
                  {spec.readinessProbe && (
                    <span className="p-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                      Readiness: {spec.readinessProbe.httpGet ? `HTTP ${spec.readinessProbe.httpGet.path}` : spec.readinessProbe.tcpSocket ? 'TCP' : 'Exec'}
                    </span>
                  )}
                  {spec.startupProbe && (
                    <span className="p-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                      Startup: {spec.startupProbe.httpGet ? `HTTP ${spec.startupProbe.httpGet.path}` : spec.startupProbe.tcpSocket ? 'TCP' : 'Exec'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Previous termination history for healthy running container */}
            {lastStateData && isHealthyRunning && (
              <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)] flex flex-wrap items-center gap-2 font-mono">
                <span className="font-semibold uppercase tracking-wider text-[9.5px] text-[var(--text-secondary)]">
                  Previous termination:
                </span>
                <span className="capitalize">{lastStateKey}</span>
                {lastStateData.reason && <span>[{lastStateData.reason}]</span>}
                {lastStateData.exitCode !== undefined && <span>Exit code: {lastStateData.exitCode}</span>}
                {lastStateData.finishedAt && <span>at {new Date(lastStateData.finishedAt).toLocaleTimeString()}</span>}
              </div>
            )}
          </div>
        </>}
      </div>
    </div>
  );
}
