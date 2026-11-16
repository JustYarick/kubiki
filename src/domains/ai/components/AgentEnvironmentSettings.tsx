import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { refreshInstalledSkills, useInstalledSkills } from '../skill_catalog';

export function AgentEnvironmentSettings() {
  const { skills, error } = useInstalledSkills();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      await refreshInstalledSkills(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ai-settings-card" aria-label="Installed skills">
      <div className="ai-card-header">
        <div>
          <h4>Skills</h4>
          <p className="ai-help">
            Loaded from <code>~/.agents/skills</code>. Type <code>$</code> in chat to reference a skill.
          </p>
        </div>
        <Button size="sm" loading={loading} onClick={() => void refresh()}>
          <RefreshCw size={12} aria-hidden="true" />
          Refresh skills
        </Button>
      </div>
      {skills.length > 0 ? (
        <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] mt-2">
          {skills.map(skill => (
            <div key={skill.name} className="py-2 flex flex-col gap-0.5">
              <code className="text-xs font-semibold text-[var(--text-primary)]">${skill.name}</code>
              <p className="ai-help">{skill.description}</p>
            </div>
          ))}
        </div>
      ) : !error && !loading ? (
        <p className="ai-help mt-1">No skills installed. Install skills with skills.sh, then select Refresh skills.</p>
      ) : null}
      {error && <p role="alert" className="ai-error mt-2">{error}</p>}
    </div>
  );
}
