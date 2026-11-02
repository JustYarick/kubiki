import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import type { OpenCodeSettings } from '../types';
export function AgentRuntimeSettings() {
  const settings=useAiStore(s=>s.settings); const saving=useAiStore(s=>s.saving);
  const [draft,setDraft]=useState<OpenCodeSettings>(settings.opencode ?? {executable:'',workingDirectory:''});
  const [message,setMessage]=useState(''); const [error,setError]=useState(''); const [testing,setTesting]=useState(false);
  useEffect(()=>{setDraft(settings.opencode ?? {executable:'',workingDirectory:''});},[settings.opencode]);
  async function save(runtime=settings.runtime ?? 'kubiki') {
    setError('');setMessage('');
    try {await useAiStore.getState().save({...useAiStore.getState().settings,runtime,opencode:draft});setMessage('Agent settings saved.');}
    catch(e){setError(agentError(e));}
  }
  async function test(){setError('');setMessage('');setTesting(true);try{const info=await agentTransport.testOpenCode(draft);setMessage(`${info.version} · ${info.executable}`);}catch(e){setError(agentError(e));}finally{setTesting(false);}}
  return <section className="ai-settings-section" aria-label="Agent selection">
    <h3>Agent</h3>
    <label className="ai-field">Use agent<Select className="ide-select" aria-label="AI agent" value={settings.runtime ?? 'kubiki'} disabled={saving || !desktopAiAvailable()} onChange={e=>void save(e.target.value as 'kubiki'|'open_code')}><option value="kubiki">Kubiki</option><option value="open_code">OpenCode</option></Select></label>
    <p className="ai-help">{settings.runtime==='open_code'?'Use your installed OpenCode with its own models, skills and permissions. Kubiki supplies the cluster connection and tools.':'Use your saved connections, skills and access rules.'}</p>
    {settings.runtime==='open_code' && <div className="ai-settings-card">
      <label className="ai-field">OpenCode executable<Input aria-label="OpenCode executable" value={draft.executable} placeholder="Find opencode on PATH" onChange={e=>setDraft({...draft,executable:e.target.value})}/></label>
      <label className="ai-field">OpenCode working directory<Input aria-label="OpenCode working directory" value={draft.workingDirectory} placeholder="Use Kubiki's default directory" onChange={e=>setDraft({...draft,workingDirectory:e.target.value})}/></label>
      <p className="ai-help">Uses your OpenCode settings. Leave the directory empty to use the Kubiki default.</p>
      <div className="ai-form-line"><Button size="sm" disabled={saving || testing || !desktopAiAvailable()} onClick={()=>void test()}>Check installation</Button><Button size="sm" disabled={saving || testing || !desktopAiAvailable()} onClick={()=>void save()}>Save OpenCode settings</Button></div>
    </div>}
    {message && <p role="status" className="ai-help">{message}</p>}{error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}
