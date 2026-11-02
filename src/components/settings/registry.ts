import type { LucideIcon } from 'lucide-react';
import { Bot, Boxes, Code2, FileCode2, FileText, Info, Network, Palette, Terminal } from 'lucide-react';
import { fuzzyScore } from '../../core/utils/fuzzy';

export type SettingsPageId = 'appearance' | 'editor' | 'terminal' | 'logs' | 'kubernetes' | 'topology' | 'ai' | 'developer' | 'about';

export interface SettingsEntry {
  /** Stable id used as a DOM anchor when jump-to-match is triggered. */
  id: string;
  label: string;
  description?: string;
  details?: string;
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
      { id: 'ai.agent', label: 'Agent', description: 'Choose Kubiki or your installed OpenCode.', keywords: 'runtime opencode executable workspace' },
      { id: 'ai.mcp', label: 'Cluster tools & data', description: 'Data and operations provided by Kubiki MCP to OpenCode.', keywords: 'exposure mcp namespaces cluster tools' },
      { id: 'ai.providers', label: 'Connections & models', description: 'Cloud and local connections, models and generation options.', keywords: 'openai anthropic ollama endpoint provider API key tokens temperature' },
      { id: 'ai.confirmations', label: 'Confirmations', description: 'Ask permission for reads or changes and always confirm selected tools.', keywords: 'ask auto accept approval consent always permissions' },
      { id: 'ai.access', label: 'Data access', description: 'Read access, Secrets, ConfigMaps, logs and allowed changes.', keywords: 'permissions read write sensitive replicas scale restart delete' },
      { id: 'ai.scope', label: 'Scope & rules', description: 'Cluster and namespace boundaries, resource rules and field filters.', keywords: 'contexts namespaces policy exclusions security' },
      { id: 'ai.integrations', label: 'Integrations', description: 'Helm, Argo CD and Flux inspection tools.', keywords: 'gitops helm argo flux' },
      { id: 'ai.environment', label: 'Skills', description: 'Installed skills.sh skills for the integrated agent.', keywords: 'skills instructions environment' },
      { id: 'ai.instructions', label: 'Instructions', description: 'Preferred language, response style and investigation conventions.', keywords: 'prompt custom language behavior agent' },
      { id: 'ai.history', label: 'History', description: 'Local transcript storage, retention and export.', keywords: 'conversations archive privacy export retention' },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: Palette,
    sectionTitle: 'Appearance',
    resetLabel: 'Reset appearance',
    entries: [
      { id: 'appearance.ui-scale', label: 'Interface scale', description: 'Scales text, icons and controls.', keywords: 'zoom size factor resize' },
      { id: 'appearance.row-density', label: 'Row density', description: 'Applies to all resource tables.', keywords: 'table compact comfortable spacing' },
      { id: 'appearance.details-tab', label: 'Default details tab', description: 'Tab opened in the details panel when a resource is selected.', keywords: 'inspector right pane yaml overview' },
      { id: 'appearance.reset-tables', label: 'Table columns and ordering', description: 'Reset columns, sorting and filters in all resource tables.', keywords: 'reset table columns order widths visibility sorts filters datagrip' },
    ],
  },
  {
    id: 'topology', title: 'Topology', icon: Network, sectionTitle: 'Topology rendering', resetLabel: 'Reset topology defaults',
    entries: [
      { id: 'topology.performance', label: 'Rendering profile', description: 'Choose Performance if large diagrams are slow.', keywords: 'graph renderer performance gpu mac macos webkit lag quality balanced fast' },
      { id: 'topology.grouping', label: 'Group resources', description: 'Group resources by namespace, or use a flat layout.', keywords: 'graph layout grouping namespace flat elk' },
      { id: 'topology.edges', label: 'Connection style', description: 'Editable routes let you move connection bends.', keywords: 'graph edge arrow curves bezier smooth straight routing' },
      { id: 'topology.animations', label: 'Animate connections', keywords: 'graph animation motion flow' },
      { id: 'topology.labels', label: 'Connection labels', keywords: 'graph edge text labels' },
      { id: 'topology.minimap', label: 'Canvas minimap', keywords: 'graph map overview' },
      { id: 'topology.background', label: 'Background grid', keywords: 'graph dots grid background' },
      { id: 'topology.updates', label: 'Diagram update interval', description: 'How often the diagram reflects resource changes. Does not change API request frequency.', keywords: 'graph refresh throttle delay interval live updates cpu' },
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
      { id: 'editor.hide-managed-fields', label: 'Hide managedFields by default', description: 'Strip metadata.managedFields from manifests in the YAML editor to keep views clean.', keywords: 'managedfields metadata strip clean status server' },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: Terminal,
    sectionTitle: 'Terminal',
    resetLabel: 'Reset terminal defaults',
    entries: [
      { id: 'terminal.font-size', label: 'Terminal font size', description: 'Independent of the interface scale; applies to OpenCode, shells and logs.', keywords: 'size text' },
      { id: 'terminal.typeface', label: 'Font and spacing', description: 'Choose a font and preview it below.', keywords: 'family nerd powerline monospace line height preview custom' },
      { id: 'terminal.scrollback', label: 'Scrollback lines', description: 'Lines kept above the visible terminal output.', keywords: 'history buffer lines memory' },
      { id: 'terminal.output-timeout', label: 'Output processing timeout', description: 'Stops a session if Kubiki cannot process its output in time.', details: 'Sessions still stop when the app window is hidden or covered. Lower timeout values apply to new sessions.', keywords: 'timeout stop disconnect keep alive stall backpressure reconnect 504' },
    ],
  },
  {
    id: 'logs',
    title: 'Logs',
    icon: FileText,
    sectionTitle: 'Logs',
    resetLabel: 'Reset log defaults',
    entries: [
      { id: 'logs.mode', label: 'Log updates', description: 'Fetch new lines at intervals or receive them as they arrive.', keywords: 'poll watch stream streaming mode ingestion' },
      { id: 'logs.poll-interval', label: 'Polling interval', description: 'Used with polling.', keywords: 'poll interval frequency cadence seconds' },
      { id: 'logs.wrap', label: 'Wrap long lines', keywords: 'soft lines overflow new sessions' },
      { id: 'logs.timestamps', label: 'Show timestamps', keywords: 'time column new sessions' },
      { id: 'logs.time-zone', label: 'Time zone', keywords: 'timezone time zone local computer UTC offset timestamp часы часовой пояс локальное время' },
      { id: 'logs.color-levels', label: 'Highlight log levels', keywords: 'color highlight level error warning info red yellow blue grafana' },
      { id: 'logs.structured', label: 'Parse JSON logs', description: 'Show JSON messages with their fields and log level. Other lines keep their original format.', keywords: 'json fields grafana parse structured format prettify level pills' },
      { id: 'logs.default-tail', label: 'Initial lines', description: 'Lines to load when opening container logs.', keywords: 'tail lines initial slice history default' },
      { id: 'logs.max-buffer', label: 'Stored lines per session', description: 'Older lines are removed when this limit is reached.', keywords: 'buffer size lines memory max limit' },
      { id: 'logs.stickiness', label: 'Follow-scroll threshold', description: 'Keep following new lines while this close to the bottom.', keywords: 'scroll stickiness follow pin distance autoscroll' },
    ],
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    icon: Boxes,
    sectionTitle: 'Kubernetes',
    resetLabel: 'Reset Kubernetes defaults',
    entries: [
      { id: 'kubernetes.remember-context', label: 'Reopen last selected cluster', description: 'Connect to the last selected kubeconfig context after restarting. If it was removed, use the current context from kubeconfig.', keywords: 'cluster context remember startup restore persistence session reopen' },
      { id: 'kubernetes.remember-scope', label: 'Remember namespaces for each cluster', description: 'Restore the namespace selection when switching clusters.', keywords: 'namespace scope context persistence restore' },
      { id: 'kubernetes.kubeconfig', label: 'Kubeconfig location', description: 'Use a custom file or the default kubeconfig location.', keywords: 'config path credentials files' },
      { id: 'kubernetes.port-range', label: 'Local port forward range', description: 'Choose a range for automatically assigned local ports.', keywords: 'port forward range local listen tunnel network' },
      { id: 'kubernetes.auto-open-browser', label: 'Auto-open browser on port forward', description: 'Automatically launch the default web browser when a port forward tunnel starts.', keywords: 'browser open url port forward tunnel http' },
    ],
  },
  {
    id: 'developer', title: 'Developer', icon: Code2, sectionTitle: 'Developer tools',
    entries: [
      { id: 'developer.mode', label: 'Developer mode', description: 'Show the demo cluster alongside kubeconfig contexts and enable the SDK Diagnostics extension. Without kubeconfig contexts, the demo cluster is always available.', keywords: 'dev sdk test diagnostics plugin extension debug demo cluster kubeconfig mock' },
    ],
  },
  {
    id: 'about',
    title: 'About',
    icon: Info,
    sectionTitle: 'About',
    entries: [
      { id: 'about.kubiki', label: 'Kubiki', keywords: 'desktop kubernetes ide version license apache author JustYarick автор features workspace clusters resources yaml logs terminals helm' },
      { id: 'about.updates', label: 'Application updates', description: 'Check for Kubiki releases in this build’s update channel and install updates.', keywords: 'update upgrade download github stable dev channel release version' },
      { id: 'about.cluster', label: 'Cluster connection', description: 'The context and API server version selected in the title bar. Connection info is read-only here.', keywords: 'context server version connected kubeconfig' },
    ],
  },
];

const entryHaystack = (entry: SettingsEntry): string => [entry.label, entry.description ?? '', entry.details ?? '', entry.keywords ?? ''].join(' ');

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
