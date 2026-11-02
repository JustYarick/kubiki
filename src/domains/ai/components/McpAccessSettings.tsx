import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { useAiStore } from '../store';
import { agentError, desktopAiAvailable } from '../transport';
import { defaultPolicy } from '../types';
import { DataSelect, Writes } from './AgentSettings';
export function McpAccessSettings(){
  const settings=useAiStore(s=>s.settings);const saving=useAiStore(s=>s.saving);
  const [draft,setDraft]=useState(settings.mcpPolicy ?? defaultPolicy());const [message,setMessage]=useState('');const [error,setError]=useState('');
  useEffect(()=>{setDraft(settings.mcpPolicy ?? defaultPolicy());},[settings.mcpPolicy]);
  async function save(){setError('');setMessage('');try{await useAiStore.getState().save({...useAiStore.getState().settings,mcpPolicy:{...draft,alwaysAsk:[],confirmReads:false,rules:[]}});setMessage('Cluster tool access saved. Restart OpenCode to reconnect.');}catch(e){setError(agentError(e));}}
  return <section className="ai-settings-section" aria-label="Kubiki MCP access">
    <div className="ai-section-header"><h3>Cluster tools & data</h3><Button size="sm" disabled={saving || !desktopAiAvailable()} onClick={()=>void save()}>Save cluster access</Button></div>
    <p className="ai-help">Choose what Kubiki provides to OpenCode. OpenCode controls permissions and confirmation prompts.</p>
    <div className="ai-settings-card"><h4>Available data</h4>
      {(['resources','events','logs','metrics','clusterResources','workloadConfiguration','annotations'] as const).map(key=><CheckboxRow key={key} label={{resources:'Resources',events:'Events',logs:'Logs',metrics:'Metrics',clusterResources:'Cluster-scoped resources',workloadConfiguration:'Workload configuration',annotations:'Annotations'}[key]} checked={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>)}
      {(['secrets','configMaps','customResources'] as const).map(key=><DataSelect key={key} label={{secrets:'Secrets',configMaps:'ConfigMaps',customResources:'Custom resources'}[key]} value={draft[key]} onChange={val=>setDraft({...draft,[key]:val})}/>)}
    </div>
    <div className="ai-settings-card"><h4>Available changes</h4><p className="ai-help">Disabled operations are unavailable through Kubiki MCP, even when OpenCode allows the call.</p><Writes value={draft.writes} onChange={writes=>setDraft({...draft,writes})}/><label className="ai-field">Maximum replicas<Input type="number" min={0} max={10000} value={draft.maxReplicas} onChange={e=>setDraft({...draft,maxReplicas:Number(e.target.value)})}/></label></div>
    <details className="ai-settings-card"><summary>Clusters, namespaces and fields</summary>
      {(['contexts','namespaces','deniedPaths'] as const).map(key=><label className="ai-field" key={key}>{{contexts:'Allowed contexts',namespaces:'Allowed namespaces',deniedPaths:'Fields to exclude'}[key]}<textarea className="ide-textarea" rows={3} value={draft[key].join('\n')} onChange={e=>setDraft({...draft,[key]:e.target.value.split('\n').map(s=>s.trim()).filter(Boolean)})}/></label>)}
    </details>
    {message && <p role="status" className="ai-help">{message}</p>}{error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}
