import type { LucideIcon } from 'lucide-react';
import { Bot, Boxes, Code2, FileCode2, FileText, Info, Palette, Terminal } from 'lucide-react';
import { fuzzyScore } from '../../core/utils/fuzzy';

export type SettingsPageId = 'appearance' | 'editor' | 'terminal' | 'logs' | 'kubernetes' | 'ai' | 'developer' | 'about';

export interface SettingsEntry {
  /** Stable id used as a DOM anchor when jump-to-match is triggered. */
  id: string;
  label: string;
  description?: string;
  /** Extra words the search matches beyond label and description. */
  keywords?: string;
}

export interface SettingsPageDef {
  id: SettingsPageId;
  title: string;
  icon: LucideIcon;
  /** Shown on the page content itself (JetBrains-style section header). */
  sectionTitle: string;
  /** Footer action label; pages without reset action omit it. */
  resetLabel?: string;
  entries: SettingsEntry[];
}

export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: 'ai', title: 'AI assistant', icon: Bot, sectionTitle: 'AI assistant',
    entries: [
      { id: 'ai.agent', label: 'Analysis agent', description: 'Analyze opens this locally installed CLI with a diagnostic snapshot. Install and sign in to the agent before using it.', keywords: 'codex opencode claude AI analyze agent assistant diagnostics' },
      { id: 'ai.starting-prompt', label: 'Starting prompt', description: 'Instructions sent before the diagnostic snapshot for every new analysis. Changes are saved on this device and apply to all analysis agents.', keywords: 'system initial prompt instructions custom edit language' },
      { id: 'ai.analysis-policy', label: 'Diagnostic snapshot', description: 'Only currently loaded resource data and matching events are included. Secret contents and environment values are excluded.', keywords: 'read only safety permissions snapshot' },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: Palette,
    sectionTitle: 'Appearance',
    resetLabel: 'Reset appearance',
    entries: [
      { id: 'appearance.ui-scale', label: 'Interface scale', description: 'Scales text, icons and controls. 100% uses a 13px base UI font.', keywords: 'zoom size factor resize' },
      { id: 'appearance.row-density', label: 'Row density', description: 'Affects table rows across all resource views.', keywords: 'table compact comfortable spacing' },
      { id: 'appearance.details-tab', label: 'Default details tab', description: 'Tab opened in the details panel when a resource is selected.', keywords: 'inspector right pane yaml overview' },
    ],
  },
  {
    id: 'editor',
    title: 'Editor',
    icon: FileCode2,
    sectionTitle: 'YAML editor',
    resetLabel: 'Reset editor defaults',
    entries: [
      { id: 'editor.font-size', label: 'YAML editor font size', description: 'Independent of the interface scale; applies to open editors.', keywords: 'monaco size text' },
      { id: 'editor.default-view', label: 'Default YAML document view', description: 'The clean view hides status and managedFields; the full view shows the document as stored by the cluster.', keywords: 'clean full status managedfields manifest' },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: Terminal,
    sectionTitle: 'Terminal',
    resetLabel: 'Reset terminal defaults',
    entries: [
      { id: 'terminal.font-size', label: 'Terminal font size', description: 'Independent of the interface scale; applies to open sessions.', keywords: 'size text' },
      { id: 'terminal.typeface', label: 'Terminal typeface', description: 'Font preset, custom family, line height and live preview. Applies to open sessions without restarting them.', keywords: 'family nerd powerline monospace line height preview custom' },
      { id: 'terminal.scrollback', label: 'Terminal scrollback limit', description: 'Lines kept above the viewport. Applies to new terminal sessions.', keywords: 'history buffer lines memory' },
      { id: 'terminal.output-timeout', label: 'Session output timeout', description: 'Stops terminal sessions whose output is not consumed for this long. Never keeps sessions open when the window is hidden or occluded; a shorter value applies to new sessions.', keywords: 'timeout stop disconnect keep alive stall backpressure reconnect 504' },
    ],
  },
  {
    id: 'logs',
    title: 'Logs',
    icon: FileText,
    sectionTitle: 'Logs',
    resetLabel: 'Reset log defaults',
    entries: [
      { id: 'logs.wrap', label: 'Wrap log lines by default', description: 'New log sessions start with line wrapping enabled; the toolbar toggle still works per session.', keywords: 'soft lines overflow new sessions' },
      { id: 'logs.timestamps', label: 'Show timestamps by default', description: 'New log sessions start with a timestamp column; the toolbar toggle still works per session.', keywords: 'time column new sessions' },
      { id: 'logs.structured', label: 'Structured log parsing by default', description: 'JSON log lines render as a message with key=value fields and the level from the record. Lines that are not JSON stay as-is; the toolbar toggle still works per session.', keywords: 'json fields grafana parse structured format prettify level' },
    ],
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    icon: Boxes,
    sectionTitle: 'Kubernetes',
    resetLabel: 'Reset Kubernetes defaults',
    entries: [
      { id: 'kubernetes.remember-scope', label: 'Remember namespace scope per context', description: 'Restores the namespace selection of each context when it is selected again.', keywords: 'namespace scope context persistence restore' },
      { id: 'kubernetes.kubeconfig', label: 'Kubeconfig location', description: 'Configure custom kubeconfig file path or use the default location (~/.kube/config / $KUBECONFIG).', keywords: 'config path credentials files' },
    ],
  },
  {
    id: 'developer', title: 'Developer', icon: Code2, sectionTitle: 'Developer tools',
    entries: [
      { id: 'developer.mode', label: 'Developer mode', description: 'Show the SDK Diagnostics extension in the catalog and workspace. Hidden by default.', keywords: 'dev sdk test diagnostics plugin extension debug' },
    ],
  },
  {
    id: 'about',
    title: 'About',
    icon: Info,
    sectionTitle: 'About',
    entries: [
      { id: 'about.kubiki', label: 'Kubiki', keywords: 'desktop kubernetes ide version license apache features workspace clusters resources yaml logs terminals helm' },
      { id: 'about.updates', label: 'Application updates', description: 'Check for Kubiki releases in this build’s update channel and install updates.', keywords: 'update upgrade download github stable dev channel release version' },
      { id: 'about.cluster', label: 'Cluster connection', description: 'The context and API server version selected in the title bar. Connection info is read-only here.', keywords: 'context server version connected kubeconfig' },
    ],
  },
];

const entryHaystack = (entry: SettingsEntry): string => [entry.label, entry.description ?? '', entry.keywords ?? ''].join(' ');

export function entryMatches(entry: SettingsEntry, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  return fuzzyScore(q, entryHaystack(entry)) >= 0;
}

/** Pages kept while searching: the title matches, or one of its entries matches. */
export function filterPages(query: string): SettingsPageDef[] {
  const q = query.trim();
  if (!q) return SETTINGS_PAGES;
  return SETTINGS_PAGES.filter((page) =>
    fuzzyScore(q, page.title) >= 0 || page.entries.some((entry) => entryMatches(entry, q)));
}

export function findPage(id: SettingsPageId): SettingsPageDef {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0];
}

export function findEntry(id: string): SettingsEntry {
  for (const page of SETTINGS_PAGES) {
    const entry = page.entries.find((candidate) => candidate.id === id);
    if (entry) return entry;
  }
  throw new Error(`Unknown settings entry: ${id}`);
}

export function firstMatchingPage(query: string): SettingsPageDef | undefined {
  const q = query.trim();
  if (!q) return undefined;
  let best: { page: SettingsPageDef; score: number } | undefined;
  for (const page of SETTINGS_PAGES) {
    for (const entry of page.entries) {
      const score = fuzzyScore(q, entryHaystack(entry));
      if (score < 0) continue;
      if (!best || score > best.score) best = { page, score };
    }
  }
  return best?.page;
}
