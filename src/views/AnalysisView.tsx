import { Bot, Copy } from 'lucide-react';
import { AI_AGENTS, ANALYSIS_INSTRUCTIONS } from '../core/ai_analysis';
import type { DockSession } from '../state/dock_store';
import { TerminalSessionPane } from '../components/layout/BottomDock';
import { Button } from '../components/ui/Button';
import { toast } from '../state/notifications_store';
import { k8s } from '../providers/k8s_provider';

export function AnalysisView({ session, visible }: { session: DockSession; visible: boolean }) {
  const analysis = session.analysis!;
  const name = AI_AGENTS.find(agent => agent.id === analysis.agent)?.label;
  return <section aria-label="Resource analysis" className="flex-1 min-h-0 min-w-0 flex flex-col">
    <header className="shrink-0 flex flex-wrap items-center gap-2 p-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] text-xs">
      <Bot size={16} aria-hidden="true" className="text-[var(--status-danger)] shrink-0" />
      <span className="flex-1 min-w-0">{name} · {analysis.prompt.startsWith(`${ANALYSIS_INSTRUCTIONS}\n\n`) ? 'Analysis only' : 'Custom prompt'} · diagnostic snapshot</span>
      <Button size="sm" onClick={() => { void navigator.clipboard.writeText(analysis.prompt).then(() => toast.success('Analysis prompt copied')).catch(() => toast.error('Clipboard unavailable')); }}><Copy size={12} aria-hidden="true" />Copy prompt</Button>
      <details className="w-full min-w-0"><summary className="cursor-pointer text-[var(--text-secondary)]">Initial message</summary><pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto p-2 mt-2 rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] text-xs">{analysis.prompt}</pre></details>
    </header>
    {k8s.demo || !k8s.supportsResourceWatch ? <p className="p-4 text-sm text-[var(--text-secondary)]">AI agents launch in the desktop app. The prepared message is available above.</p> : <div className="flex-1 min-h-0 min-w-0"><TerminalSessionPane session={session} visible={visible} /></div>}
  </section>;
}
