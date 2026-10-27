import { selectedFirst } from '../../core/utils/selected_first';
import { Check, ChevronDown, Circle } from 'lucide-react';
import type { ResourceContainer } from '../../types/k8s';
import { canExecContainer, containerSummary, containerTone, CONTAINER_ROLE_LABEL } from '../../core/resources/containers';
import { Popover } from '../ui/Dropdown';

const tones = { ok: 'text-[var(--status-ok)]', warn: 'text-[var(--status-warn)]', danger: 'text-[var(--status-danger)]', muted: 'text-[var(--text-muted)]', info: 'text-[var(--status-pending)]' };
export function ContainerStatusIcon({ container }: { container: ResourceContainer }) {
  const label = containerSummary(container);
  return <span role="img" aria-label={label} title={label} data-container-status={container.state ?? 'unknown'} className={`inline-flex shrink-0 ${tones[containerTone(container)]}`}><Circle size="calc(8px * var(--ui-factor))" fill="currentColor" strokeWidth={0} /></span>;
}
export function ContainerIndicators({ containers }: { containers: ResourceContainer[] }) {
  return <span className="inline-flex items-center gap-1 ml-1" aria-label="Container statuses">{containers.slice(0, 6).map((container) => <ContainerStatusIcon key={container.name} container={container} />)}{containers.length > 6 && <span title={containers.slice(6).map(containerSummary).join('\n')}>+{containers.length - 6}</span>}</span>;
}
export function ContainerSelect({ containers, value, onChange, shell = false, headerLabel }: { containers: ResourceContainer[]; value: string; onChange: (name: string) => void; shell?: boolean; headerLabel?: string }) {
  const current = containers.find((container) => container.name === value);
  return <Popover width={330} trigger={({ open }) => <button type="button" aria-label="Select Container" aria-haspopup="listbox" aria-expanded={open} title="Select Container" className="flex items-center gap-1.5 h-7 min-w-0 max-w-full px-2 rounded border border-[var(--border-default)] text-xs font-mono hover:bg-[var(--bg-hover)]">
    {current && <ContainerStatusIcon container={current} />}<span className="truncate">{value || 'Choose container'}</span><ChevronDown size="calc(11px * var(--ui-factor))" className="shrink-0" />
  </button>}>
    {(close) => <div role="listbox" aria-label={shell ? 'Shell containers' : 'Containers'} className="max-h-[50vh] overflow-auto">
      <div className="px-3 py-1 text-xs text-[var(--text-muted)]">{headerLabel ?? (shell ? 'Shell · running containers' : 'Logs · all containers')}</div>
      {selectedFirst(containers, container => container.name === value).map((container) => <button type="button" role="option" aria-selected={container.name === value} disabled={shell && !canExecContainer(container)} key={container.name} title={containerSummary(container)} onClick={() => { onChange(container.name); close(); }} className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
        <ContainerStatusIcon container={container} /><span className="min-w-0 flex-1"><span className="block font-mono text-xs truncate">{container.name}</span><span className="block text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] truncate">{CONTAINER_ROLE_LABEL[container.role ?? 'application']} · {container.reason ?? container.state ?? 'unknown'}{container.exitCode !== undefined ? ` · exit ${container.exitCode}` : ''}</span></span>{container.name === value && <Check size="calc(12px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />}
      </button>)}
    </div>}
  </Popover>;
}
