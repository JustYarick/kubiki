import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import { externalAgentName, type AgentRuntime, type OpenCodeSettings } from '../types';
export function AgentRuntimeSettings() {
  const settings=useAiStore(s=>s.settings); const saving=useAiStore(s=>s.saving);
  const runtime = settings.runtime ?? 'kubiki';
  const key = runtime === 'codex' ? 'codex' : runtime === 'claude' ? 'claude' : 'opencode';
  const name = externalAgentName(runtime);
  const [draft,setDraft]=useState<OpenCodeSettings>(settings[key] ?? {executable:'',workingDirectory:''});
  const [message,setMessage]=useState(''); const [error,setError]=useState(''); const [testing,setTesting]=useState(false);
  useEffect(()=>{setDraft(settings[key] ?? {executable:'',workingDirectory:''});},[settings[key], key]);
  async function save(runtime=settings.runtime ?? 'kubiki') {
    setError('');setMessage('');
    try {await useAiStore.getState().save({...useAiStore.getState().settings,runtime,[key]:draft});setMessage('Agent settings saved.');}
    catch(e){setError(agentError(e));}
  }
  async function test(){setError('');setMessage('');setTesting(true);try{const info=runtime === 'open_code' ? await agentTransport.testOpenCode(draft) : await agentTransport.testExternalAgent(runtime, draft);setMessage(`${info.version} · ${info.executable}`);}catch(e){setError(agentError(e));}finally{setTesting(false);}}
  return <section className="ai-settings-section" aria-label="Agent selection">
    <h3>Agent</h3>
    <label className="ai-field">Use agent<Select className="ide-select" aria-label="AI agent" value={settings.runtime ?? 'kubiki'} disabled={saving || !desktopAiAvailable()} onChange={e=>void save(e.target.value as AgentRuntime)}><option value="kubiki">Kubiki</option><option value="open_code">OpenCode</option><option value="codex">Codex</option><option value="claude">Claude Code</option></Select></label>
    <p className="ai-help">{runtime!=='kubiki'?`Use your installed ${name} with its own models, skills and permissions. Kubiki supplies the cluster connection and tools.`:'Use your saved connections, skills and access rules.'}</p>
    {runtime!=='kubiki' && <div className="ai-settings-card">
      <label className="ai-field">{name} executable<Input aria-label={`${name} executable`} value={draft.executable} placeholder={`Find ${runtime === 'open_code' ? 'opencode' : runtime} on PATH`} onChange={e=>setDraft({...draft,executable:e.target.value})}/></label>
      <label className="ai-field">{name} working directory<Input aria-label={`${name} working directory`} value={draft.workingDirectory} placeholder="Use Kubiki's default directory" onChange={e=>setDraft({...draft,workingDirectory:e.target.value})}/></label>
      <p className="ai-help">Uses your {name} settings. Leave the directory empty to use the Kubiki default.</p>
      <div className="ai-form-line"><Button size="sm" disabled={saving || testing || !desktopAiAvailable()} onClick={()=>void test()}>Check installation</Button><Button size="sm" disabled={saving || testing || !desktopAiAvailable()} onClick={()=>void save()}>Save {name} settings</Button></div>
    </div>}
    {message && <p role="status" className="ai-help">{message}</p>}{error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}
