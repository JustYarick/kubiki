import { performResourceAction } from '../../../../providers/resource_actions';
import { useState } from 'react';
import { Play, Clock, Layers, Activity } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { toast } from '../../../../state/notifications_store';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { ContainerCard } from '../blocks/ContainerCard';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { Button } from '../../../ui/Button';

interface JobDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs: (container?: string) => void;
  onShell: (container?: string) => void;
}

export function JobDetails({ item, onNavigate, onLogs, onShell }: JobDetailsProps) {
  const resources = useResourceStore((s) => s.resources);
  const currentContext = useClusterStore((s) => s.currentContext);
  const [triggering, setTriggering] = useState(false);

  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const isCronJob = item.kind === 'CronJob';

  // For Job:
  const completions = spec.completions ?? 1;
  const parallelism = spec.parallelism ?? 1;
  const backoffLimit = spec.backoffLimit ?? 6;
  const activeCount = status.active ?? 0;
  const succeededCount = status.succeeded ?? 0;
  const failedCount = status.failed ?? 0;

  const startTime = status.startTime ? new Date(status.startTime) : undefined;
  const completionTime = status.completionTime ? new Date(status.completionTime) : undefined;
  const durationSec = startTime && completionTime ? Math.round((completionTime.getTime() - startTime.getTime()) / 1000) : undefined;

  // For CronJob:
  const schedule = spec.schedule ?? '';
  const suspend = spec.suspend === true;
  const concurrencyPolicy = spec.concurrencyPolicy ?? 'Allow';
  const lastScheduleTime = status.lastScheduleTime;
  const activeJobsRefs: Array<{ name: string; namespace?: string }> = status.active ?? [];

  // Containers template
  const templateSpec = isCronJob
    ? spec.jobTemplate?.spec?.template?.spec ?? {}
    : spec.template?.spec ?? {};
  const templateContainers: any[] = templateSpec.containers ?? [];

  // Child pods for Job
  const jobPods = !isCronJob
    ? [...resources.Pod.values()].filter((pod) => {
        if (item.namespace && pod.namespace !== item.namespace) return false;
        const owners = pod.raw?.metadata?.ownerReferences ?? [];
        return owners.some((o: any) => o.name === item.name || o.uid === item.uid);
      })
    : [];

  const handleToggleSuspend = async () => {
    if (!isCronJob) return;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const nextSuspended = !suspend;
    const updatedRaw = {
      ...raw,
      spec: {
        ...(raw.spec ?? {}),
        suspend: nextSuspended,
      },
    };
    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem('CronJob', item.uid, {
          ...item,
          raw: updatedRaw,
        });
        toast.success(`CronJob ${item.name} ${nextSuspended ? 'suspended' : 'resumed'} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'suspend', suspend: nextSuspended });
        toast.success(`CronJob ${item.name} ${nextSuspended ? 'suspended' : 'resumed'}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Suspend/resume cancelled');
      else toast.error('Failed to update suspend state', String(err?.message || err));
    }
  };

  const handleTriggerRunNow = async () => {
    if (!isCronJob) return;
    try {
      setTriggering(true);
      const manualJobName = `${item.name}-manual-${Math.floor(Date.now() / 1000).toString().slice(-4)}`;
      if (k8s.demo) {
        toast.success(`Job ${manualJobName} triggered (demo simulation)`);
      } else {
        if (!currentContext) {
          toast.error('No active cluster context');
          return;
        }
        await performResourceAction(currentContext, item, { type: 'run_cron_job', name: manualJobName });
        toast.success(`Spawned Job ${manualJobName}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Job trigger cancelled');
      } else {
        toast.error('Failed to trigger job', String(err?.message || err));
      }
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Job / CronJob Execution Summary */}
      <section aria-label="Job execution summary" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              {isCronJob ? 'Cron Schedule & State' : 'Job Execution & Pods'}
            </span>
          </div>
          {isCronJob ? (
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[length:calc(10px*var(--ui-factor))] font-mono font-medium ${
                suspend ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              }`}>
                {suspend ? 'Suspended' : 'Active'}
              </span>
              <Button size="sm" variant="secondary" onClick={handleToggleSuspend}>
                {suspend ? 'Resume' : 'Suspend'}
              </Button>
              <Button size="sm" variant="primary" disabled={triggering} onClick={handleTriggerRunNow}>
                <Play size="calc(11px * var(--ui-factor))" />
                {triggering ? 'Triggering…' : 'Run Now'}
              </Button>
            </div>
          ) : (
            <span className={`px-1.5 py-0.5 rounded text-[length:calc(10px*var(--ui-factor))] font-mono font-medium ${
              succeededCount >= completions ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : failedCount > 0 ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
            }`}>
              {succeededCount >= completions ? 'Completed' : activeCount > 0 ? 'Running' : 'Pending'}
            </span>
          )}
        </div>

        <div className="p-2">
          {isCronJob ? (
            <dl className="details-properties">
              <dt className="text-[var(--text-secondary)]">Schedule</dt>
              <dd className="font-mono text-[var(--accent)] font-semibold">{schedule}</dd>

              <dt className="text-[var(--text-secondary)]">Concurrency</dt>
              <dd className="font-mono text-[var(--text-primary)]">{concurrencyPolicy}</dd>

              <dt className="text-[var(--text-secondary)]">Last Schedule Time</dt>
              <dd className="font-mono text-[var(--text-primary)]">
                {lastScheduleTime ? new Date(lastScheduleTime).toLocaleString() : 'Never'}
              </dd>

              <dt className="text-[var(--text-secondary)]">Active Jobs</dt>
              <dd className="font-mono text-[var(--text-primary)]">{activeJobsRefs.length}</dd>
            </dl>
          ) : (
            <div className="details-stack">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-center">
                  <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Succeeded</span>
                  <span className="font-mono text-base font-semibold text-emerald-400">{succeededCount} / {completions}</span>
                </div>
                <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-center">
                  <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Active</span>
                  <span className="font-mono text-base font-semibold text-blue-400">{activeCount}</span>
                </div>
                <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-center">
                  <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Failed</span>
                  <span className="font-mono text-base font-semibold text-rose-400">{failedCount} / {backoffLimit}</span>
                </div>
              </div>

              <dl className="details-properties pt-2 border-t border-[var(--border-subtle)]">
                {durationSec !== undefined && (
                  <>
                    <dt className="text-[var(--text-secondary)]">Duration</dt>
                    <dd className="font-mono text-emerald-400 font-semibold">{durationSec}s</dd>
                  </>
                )}
                {startTime && (
                  <>
                    <dt className="text-[var(--text-secondary)]">Started</dt>
                    <dd className="font-mono text-[var(--text-primary)]">{startTime.toLocaleString()}</dd>
                  </>
                )}
                {completionTime && (
                  <>
                    <dt className="text-[var(--text-secondary)]">Completed</dt>
                    <dd className="font-mono text-[var(--text-primary)]">{completionTime.toLocaleString()}</dd>
                  </>
                )}
                <dt className="text-[var(--text-secondary)]">Parallelism</dt>
                <dd className="font-mono text-[var(--text-primary)]">{parallelism}</dd>
              </dl>
            </div>
          )}
        </div>
      </section>

      {/* 3. Pod Template Containers */}
      <section aria-label="Job Container Template" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Container Template ({templateContainers.length})
            </span>
          </div>
        </div>
        <div className="p-2 space-y-2.5">
          {templateContainers.map((c: any) => (
            <ContainerCard
              key={c.name}
              container={{
                name: c.name,
                image: c.image ?? '',
                role: 'application',
                state: 'running',
                ready: true,
                restarts: 0,
                port: '-',
              }}
              spec={c}
              status={{}}
              onLogs={() => onLogs(c.name)}
              onShell={() => onShell(c.name)}
            />
          ))}
        </div>
      </section>

      {/* 4. Child Pods for Job */}
      {!isCronJob && jobPods.length > 0 && (
        <section aria-label="Job Pods" className="details-section">
          <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                Job Pods ({jobPods.length})
              </span>
            </div>
          </div>
          <div className="p-2 divide-y divide-[var(--border-subtle)]">
            {jobPods.map((pod) => (
              <div key={pod.uid} className="flex items-center justify-between py-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => onNavigate(pod)}
                  className="font-mono text-[var(--accent)] hover:underline truncate text-left"
                >
                  {pod.name}
                </button>
                <span className={`font-mono text-[length:calc(10.5px*var(--ui-factor))] ${
                  pod.status === 'Completed' || pod.status === 'Succeeded' ? 'text-emerald-400' : pod.status === 'Failed' ? 'text-rose-400' : 'text-blue-400'
                }`}>
                  {pod.status ?? '—'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 6. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
