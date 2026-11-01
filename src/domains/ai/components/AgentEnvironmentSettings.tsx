import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { refreshInstalledSkills, useInstalledSkills } from '../skill_catalog';
export function AgentEnvironmentSettings() {
  const {skills,error}=useInstalledSkills(); const [loading,setLoading]=useState(false);
  async function refresh(){setLoading(true);try{await refreshInstalledSkills(true);}finally{setLoading(false);}}
  return <section className="ai-settings-section" aria-label="Installed skills">
    <div className="ai-section-header"><h3>Skills</h3><Button size="sm" disabled={loading} onClick={()=>void refresh()}>Refresh skills</Button></div>
    <p className="ai-help">Uses skills.sh’s global directory: <code>~/.agents/skills</code>. Type <code>$</code> in chat to select a skill.</p>
    {skills.map(skill=><div className="ai-settings-card" key={skill.name}><strong>${skill.name}</strong><p className="ai-help">{skill.description}</p></div>)}
    {!skills.length && <p className="ai-help">No installed skills found.</p>}{error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}
