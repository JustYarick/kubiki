import type { LucideIcon } from 'lucide-react';
import { Bot, Boxes, Code2, FileCode2, FileText, Info, Network, Palette, Terminal } from 'lucide-react';
import { fuzzyScore } from '../../core/utils/fuzzy';

export type SettingsPageId = 'appearance' | 'editor' | 'terminal' | 'logs' | 'kubernetes' | 'topology' | 'ai' | 'developer' | 'about';

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
      { id: 'ai.providers', label: 'Integrated agent providers', description: 'Cloud and local API connections, dynamic model discovery and generation options.', keywords: 'openai anthropic ollama lm studio vllm gemini deepseek openrouter groq mistral endpoint models API key' },
      { id: 'ai.permissions', label: 'Integrated agent permissions', description: 'Control resource access, Secrets, ConfigMaps, logs, namespaces, write operations and field exclusions.', keywords: 'read only ask accept safety policy rules secret config security agent' },
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
      { id: 'appearance.reset-tables', label: 'Table columns and ordering', description: 'Restore default column order, widths, visibility, sorts and filters for all resource tables.', keywords: 'reset table columns order widths visibility sorts filters datagrip' },
    ],
  },
  {
    id: 'topology', title: 'Topology', icon: Network, sectionTitle: 'Topology rendering', resetLabel: 'Reset topology defaults',
    entries: [
      { id: 'topology.performance', label: 'Rendering profile', description: 'Performance uses straight static lines and compact nodes, disables shadows, labels, grid and minimap, and limits live redraws to once every 3 seconds or slower. Useful for large diagrams and Macs with slow panning.', keywords: 'graph renderer performance gpu mac macos webkit lag quality balanced fast' },
      { id: 'topology.grouping', label: 'Cluster layout grouping', description: 'Namespace boxes preserve hierarchy. Flat layout reduces layout work for large diagrams.', keywords: 'graph layout grouping namespace flat elk' },
      { id: 'topology.edges', label: 'Connection style', description: 'Editable routes support custom bends. Straight connections need less rendering work. Performance always uses straight lines.', keywords: 'graph edge arrow curves bezier smooth straight routing' },
      { id: 'topology.animations', label: 'Animate connections', description: 'Animate flow along connections. Disabled in Performance and when the system requests reduced motion.', keywords: 'graph animation motion flow' },
      { id: 'topology.labels', label: 'Connection labels', description: 'Show relationship names on connections. Disabled in Performance.', keywords: 'graph edge text labels' },
      { id: 'topology.minimap', label: 'Canvas minimap', description: 'Show a miniature overview of the whole graph. Disabled in Performance.', keywords: 'graph map overview' },
      { id: 'topology.background', label: 'Background grid', description: 'Show the dotted canvas background. Disabled in Performance.', keywords: 'graph dots grid background' },
      { id: 'topology.updates', label: 'Live redraw interval', description: 'Coalesce incoming resource changes before rebuilding the diagram. Scope changes skip this delay. This affects local rendering, not Kubernetes API requests; Performance uses at least 3 seconds.', keywords: 'graph refresh throttle delay interval live updates cpu' },
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
      { id: 'logs.mode', label: 'Log ingestion mode', description: 'Choose between periodic polling (Lens-style) or continuous streaming watch for container logs.', keywords: 'poll watch stream streaming mode ingestion' },
      { id: 'logs.poll-interval', label: 'Default log polling interval', description: 'Cadence for fetching new log lines in polling mode (in seconds).', keywords: 'poll interval frequency cadence seconds' },
      { id: 'logs.wrap', label: 'Wrap log lines by default', description: 'Wrap long log lines. Changes in settings or the toolbar are remembered across log panes.', keywords: 'soft lines overflow new sessions' },
      { id: 'logs.timestamps', label: 'Show timestamps by default', description: 'Show a timestamp column. Changes in settings or the toolbar are remembered across log panes.', keywords: 'time column new sessions' },
      { id: 'logs.time-zone', label: 'Timestamp time zone', description: 'Display log timestamps in UTC or convert them to the computer’s local time zone. The choice applies to all log panes and is remembered.', keywords: 'timezone time zone local computer UTC offset timestamp часы часовой пояс локальное время' },
      { id: 'logs.color-levels', label: 'Highlight log levels', description: 'Colorize error in red, warning in yellow, and info in blue across log sessions.', keywords: 'color highlight level error warning info red yellow blue grafana' },
      { id: 'logs.structured', label: 'Structured log parsing by default', description: 'JSON log lines render as a message with key:value field pills and the level from the record like Grafana. Lines that are not JSON stay as-is. Changes in settings or the toolbar are remembered across log panes.', keywords: 'json fields grafana parse structured format prettify level pills' },
      { id: 'logs.default-tail', label: 'Default log tail lines', description: 'Number of lines to read initially when opening container logs.', keywords: 'tail lines initial slice history default' },
      { id: 'logs.max-buffer', label: 'Max log buffer size', description: 'Maximum lines kept in memory per session before older output is discarded.', keywords: 'buffer size lines memory max limit' },
      { id: 'logs.stickiness', label: 'Auto-scroll stickiness', description: 'Distance from the bottom of the log viewer to maintain auto-scroll when new lines arrive.', keywords: 'scroll stickiness follow pin distance autoscroll' },
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
      { id: 'kubernetes.remember-scope', label: 'Remember namespace scope per context', description: 'Restores the namespace selection of each context when it is selected again.', keywords: 'namespace scope context persistence restore' },
      { id: 'kubernetes.kubeconfig', label: 'Kubeconfig location', description: 'Configure custom kubeconfig file path or use the default location (~/.kube/config / $KUBECONFIG).', keywords: 'config path credentials files' },
      { id: 'kubernetes.port-range', label: 'Local port forward range', description: 'Preferred local port range for auto-assigning local tunnel listeners (e.g. 8000-8999).', keywords: 'port forward range local listen tunnel network' },
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
