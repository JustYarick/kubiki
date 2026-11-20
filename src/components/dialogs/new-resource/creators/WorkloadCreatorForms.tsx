import { useId } from 'react';
import { Box, CalendarClock, Layers, PlayCircle } from 'lucide-react';
import {
  CRONJOB_CONCURRENCY_POLICIES,
  DEPLOYMENT_STRATEGIES,
  JOB_RESTART_POLICIES,
  POD_RESTART_POLICIES,
  type CronJobConcurrencyPolicy,
  type CronJobCreatorState,
  type DeploymentCreatorState,
  type DeploymentStrategy,
  type JobCreatorState,
  type JobRestartPolicy,
  type PodCreatorState,
  type PodRestartPolicy,
} from '../../../../core/resources/creators';
import { CheckboxRow } from '../../../ui/Checkbox';
import { Input } from '../../../ui/Input';
import { Field, FieldGroup, SectionCard } from '../../../ui/LayoutPrimitives';
import { Select } from '../../../ui/Select';
import { ContainersEditor, KeyValuePairsEditor } from '../SharedFormParts';
import type { ResourceCreatorFormProps } from '../types';

export function DeploymentCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<DeploymentCreatorState>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Deployment Spec" icon={Layers}>
        <div className="flex flex-col gap-3">
          <FieldGroup>
            <Field label="Replicas" htmlFor={`${id}-replicas`} required>
              <Input
                id={`${id}-replicas`}
                size="sm"
                mono
                type="number"
                min={0}
                disabled={disabled}
                value={state.replicas}
                onChange={(e) => onChange({ ...state, replicas: e.target.value })}
              />
            </Field>
            <Field label="Update Strategy" htmlFor={`${id}-strategy`}>
              <Select
                id={`${id}-strategy`}
                size="sm"
                disabled={disabled}
                value={state.strategy}
                onChange={(e) => onChange({ ...state, strategy: e.target.value as DeploymentStrategy })}
              >
                {DEPLOYMENT_STRATEGIES.map((strategy) => (
                  <option key={strategy} value={strategy}>{strategy}</option>
                ))}
              </Select>
            </Field>
            <Field label="Service Account (optional)" htmlFor={`${id}-sa`}>
              <Input
                id={`${id}-sa`}
                size="sm"
                mono
                disabled={disabled}
                placeholder="default"
                value={state.serviceAccountName}
                onChange={(e) => onChange({ ...state, serviceAccountName: e.target.value })}
              />
            </Field>
          </FieldGroup>

          {state.strategy === 'RollingUpdate' && (
            <FieldGroup>
              <Field label="Max Surge (optional)" htmlFor={`${id}-surge`} hint="Number or percentage, e.g. 25%">
                <Input
                  id={`${id}-surge`}
                  size="sm"
                  mono
                  disabled={disabled}
                  placeholder="25%"
                  value={state.maxSurge}
                  onChange={(e) => onChange({ ...state, maxSurge: e.target.value })}
                />
              </Field>
              <Field label="Max Unavailable (optional)" htmlFor={`${id}-unavail`} hint="Number or percentage, e.g. 25%">
                <Input
                  id={`${id}-unavail`}
                  size="sm"
                  mono
                  disabled={disabled}
                  placeholder="25%"
                  value={state.maxUnavailable}
                  onChange={(e) => onChange({ ...state, maxUnavailable: e.target.value })}
                />
              </Field>
            </FieldGroup>
          )}

          <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Selector & Pod Template Labels</span>
            <KeyValuePairsEditor
              entries={state.selectorLabels}
              disabled={disabled}
              keyPlaceholder="app"
              valuePlaceholder="web"
              addLabel="Add selector label"
              emptyText="Add at least one label to match Pods."
              ariaPrefix="Selector label"
              onChange={(selectorLabels) => onChange({ ...state, selectorLabels })}
            />
          </div>
        </div>
      </SectionCard>

      <ContainersEditor
        containers={state.containers}
        disabled={disabled}
        onChange={(containers) => onChange({ ...state, containers })}
      />
    </div>
  );
}

export function PodCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<PodCreatorState>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Pod Options" icon={Box}>
        <FieldGroup>
          <Field label="Restart Policy" htmlFor={`${id}-restart`}>
            <Select
              id={`${id}-restart`}
              size="sm"
              disabled={disabled}
              value={state.restartPolicy}
              onChange={(e) => onChange({ ...state, restartPolicy: e.target.value as PodRestartPolicy })}
            >
              {POD_RESTART_POLICIES.map((policy) => (
                <option key={policy} value={policy}>{policy}</option>
              ))}
            </Select>
          </Field>
          <Field label="Service Account (optional)" htmlFor={`${id}-sa`}>
            <Input
              id={`${id}-sa`}
              size="sm"
              mono
              disabled={disabled}
              placeholder="default"
              value={state.serviceAccountName}
              onChange={(e) => onChange({ ...state, serviceAccountName: e.target.value })}
            />
          </Field>
          <Field label="Node Name (optional)" htmlFor={`${id}-node`}>
            <Input
              id={`${id}-node`}
              size="sm"
              mono
              disabled={disabled}
              placeholder="Automatic scheduling"
              value={state.nodeName}
              onChange={(e) => onChange({ ...state, nodeName: e.target.value })}
            />
          </Field>
        </FieldGroup>
      </SectionCard>

      <ContainersEditor
        containers={state.containers}
        disabled={disabled}
        onChange={(containers) => onChange({ ...state, containers })}
      />
    </div>
  );
}

export function JobCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<JobCreatorState>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Job Execution" icon={PlayCircle}>
        <FieldGroup>
          <Field label="Completions (optional)" htmlFor={`${id}-completions`}>
            <Input
              id={`${id}-completions`}
              size="sm"
              mono
              type="number"
              min={1}
              disabled={disabled}
              placeholder="1"
              value={state.completions}
              onChange={(e) => onChange({ ...state, completions: e.target.value })}
            />
          </Field>
          <Field label="Parallelism (optional)" htmlFor={`${id}-parallelism`}>
            <Input
              id={`${id}-parallelism`}
              size="sm"
              mono
              type="number"
              min={0}
              disabled={disabled}
              placeholder="1"
              value={state.parallelism}
              onChange={(e) => onChange({ ...state, parallelism: e.target.value })}
            />
          </Field>
          <Field label="Backoff Limit (optional)" htmlFor={`${id}-backoff`}>
            <Input
              id={`${id}-backoff`}
              size="sm"
              mono
              type="number"
              min={0}
              disabled={disabled}
              placeholder="6"
              value={state.backoffLimit}
              onChange={(e) => onChange({ ...state, backoffLimit: e.target.value })}
            />
          </Field>
          <Field label="TTL After Finished (sec)" htmlFor={`${id}-ttl`}>
            <Input
              id={`${id}-ttl`}
              size="sm"
              mono
              type="number"
              min={0}
              disabled={disabled}
              placeholder="Keep indefinitely"
              value={state.ttlSecondsAfterFinished}
              onChange={(e) => onChange({ ...state, ttlSecondsAfterFinished: e.target.value })}
            />
          </Field>
          <Field label="Pod Restart Policy" htmlFor={`${id}-restart`}>
            <Select
              id={`${id}-restart`}
              size="sm"
              disabled={disabled}
              value={state.restartPolicy}
              onChange={(e) => onChange({ ...state, restartPolicy: e.target.value as JobRestartPolicy })}
            >
              {JOB_RESTART_POLICIES.map((policy) => (
                <option key={policy} value={policy}>{policy}</option>
              ))}
            </Select>
          </Field>
        </FieldGroup>
      </SectionCard>

      <ContainersEditor
        containers={state.containers}
        disabled={disabled}
        allowPorts={false}
        defaultImage="busybox:stable"
        onChange={(containers) => onChange({ ...state, containers })}
      />
    </div>
  );
}

const CRON_PRESETS = [
  { label: 'Every 5m', expr: '*/5 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 00:00', expr: '0 0 * * *' },
  { label: 'Weekly Sun', expr: '0 0 * * 0' },
] as const;

export function CronJobCreatorForm({ state, disabled, onChange }: ResourceCreatorFormProps<CronJobCreatorState>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <SectionCard title="Schedule & Policy" icon={CalendarClock}>
        <div className="flex flex-col gap-3">
          <FieldGroup>
            <Field label="Cron Schedule" htmlFor={`${id}-schedule`} required hint="5-field cron (min hour day month weekday)">
              <Input
                id={`${id}-schedule`}
                size="sm"
                mono
                disabled={disabled}
                placeholder="0 * * * *"
                value={state.schedule}
                onChange={(e) => onChange({ ...state, schedule: e.target.value })}
              />
              <div className="nr-preset-row">
                {CRON_PRESETS.map((preset) => (
                  <button
                    key={preset.expr}
                    type="button"
                    disabled={disabled}
                    data-active={state.schedule.trim() === preset.expr ? 'true' : undefined}
                    className="nr-preset-chip"
                    onClick={() => onChange({ ...state, schedule: preset.expr })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Concurrency Policy" htmlFor={`${id}-concurrency`}>
              <Select
                id={`${id}-concurrency`}
                size="sm"
                disabled={disabled}
                value={state.concurrencyPolicy}
                onChange={(e) => onChange({ ...state, concurrencyPolicy: e.target.value as CronJobConcurrencyPolicy })}
              >
                {CRONJOB_CONCURRENCY_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>{policy}</option>
                ))}
              </Select>
            </Field>
          </FieldGroup>

          <FieldGroup>
            <Field label="Successful History Limit" htmlFor={`${id}-succ`}>
              <Input
                id={`${id}-succ`}
                size="sm"
                mono
                type="number"
                min={0}
                disabled={disabled}
                placeholder="3"
                value={state.successfulJobsHistoryLimit}
                onChange={(e) => onChange({ ...state, successfulJobsHistoryLimit: e.target.value })}
              />
            </Field>
            <Field label="Failed History Limit" htmlFor={`${id}-fail`}>
              <Input
                id={`${id}-fail`}
                size="sm"
                mono
                type="number"
                min={0}
                disabled={disabled}
                placeholder="1"
                value={state.failedJobsHistoryLimit}
                onChange={(e) => onChange({ ...state, failedJobsHistoryLimit: e.target.value })}
              />
            </Field>
            <Field label="Pod Restart Policy" htmlFor={`${id}-restart`}>
              <Select
                id={`${id}-restart`}
                size="sm"
                disabled={disabled}
                value={state.restartPolicy}
                onChange={(e) => onChange({ ...state, restartPolicy: e.target.value as JobRestartPolicy })}
              >
                {JOB_RESTART_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>{policy}</option>
                ))}
              </Select>
            </Field>
          </FieldGroup>

          <CheckboxRow
            label="Start suspended (do not schedule runs until resumed)"
            checked={state.suspend}
            disabled={disabled}
            onChange={(e) => onChange({ ...state, suspend: e.target.checked })}
          />
        </div>
      </SectionCard>

      <ContainersEditor
        containers={state.containers}
        disabled={disabled}
        allowPorts={false}
        defaultImage="busybox:stable"
        onChange={(containers) => onChange({ ...state, containers })}
      />
    </div>
  );
}
