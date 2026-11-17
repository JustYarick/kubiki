import { Anchor, Bot, Braces, CircleDot, GitBranch, LayoutDashboard } from 'lucide-react';
import overviewWebm from '../media/overview.webm';
import overviewMp4 from '../media/overview.mp4';
import overviewPoster from '../media/overview.webp';
import resourcesWebm from '../media/resources.webm';
import resourcesMp4 from '../media/resources.mp4';
import resourcesPoster from '../media/resources.webp';
import topologyWebm from '../media/topology.webm';
import topologyMp4 from '../media/topology.mp4';
import topologyPoster from '../media/topology.webp';
import yamlWebm from '../media/yaml.webm';
import yamlMp4 from '../media/yaml.mp4';
import yamlPoster from '../media/yaml.webp';
import helmWebm from '../media/helm.webm';
import helmMp4 from '../media/helm.mp4';
import helmPoster from '../media/helm.webp';
import agentWebm from '../media/agent.webm';
import agentMp4 from '../media/agent.mp4';
import agentPoster from '../media/agent.webp';

export type StageScene = {
  id: string;
  name: string;
  breadcrumb: string;
  caption: string;
  description: string;
  icon: typeof LayoutDashboard;
  webm: string;
  mp4: string;
  poster: string;
};

export const stageScenes: StageScene[] = [
  {
    id: 'overview',
    name: 'Overview',
    breadcrumb: 'kubiki-demo › Overview',
    caption: 'Cluster telemetry at a glance',
    description: 'CPU and memory history, Pod lifecycle distribution and prioritized problems across 184 nodes.',
    icon: LayoutDashboard,
    webm: overviewWebm,
    mp4: overviewMp4,
    poster: overviewPoster,
  },
  {
    id: 'resources',
    name: 'Diagnostics',
    breadcrumb: 'kubiki-demo › Pods › payment-worker',
    caption: 'Filter, inspect and trace',
    description: 'Search 8,476 Pods, spot CrashLoopBackOff immediately, and move between Events and Related objects.',
    icon: CircleDot,
    webm: resourcesWebm,
    mp4: resourcesMp4,
    poster: resourcesPoster,
  },
  {
    id: 'topology',
    name: 'Topology',
    breadcrumb: 'kubiki-demo › Topology › payments-redis',
    caption: 'Every dependency mapped',
    description: 'Interactive ELK-arranged resource graphs linking Workloads, Services, PVCs, Secrets and NetworkPolicies.',
    icon: GitBranch,
    webm: topologyWebm,
    mp4: topologyMp4,
    poster: topologyPoster,
  },
  {
    id: 'yaml',
    name: 'YAML Splits',
    breadcrumb: 'kubiki-demo › Pod › api-gateway.yaml',
    caption: 'Clean manifests & split view',
    description: 'Hide noisy managedFields and status, search with Monaco, and open side-by-side split panes.',
    icon: Braces,
    webm: yamlWebm,
    mp4: yamlMp4,
    poster: yamlPoster,
  },
  {
    id: 'helm',
    name: 'Helm',
    breadcrumb: 'kubiki-demo › Helm › payments-prod-api',
    caption: 'Revisions without guesswork',
    description: 'Inspect complete release snapshots, compare earlier revisions, read rendered manifests and hook Jobs.',
    icon: Anchor,
    webm: helmWebm,
    mp4: helmMp4,
    poster: helmPoster,
  },
  {
    id: 'agent',
    name: 'AI Agent',
    breadcrumb: 'kubiki-demo › AI Agent › Investigation',
    caption: 'Scoped evidence, plan first',
    description: 'Diagnose OOMKilled Pods with bounded MCP tools and review structured remediation plans before writes.',
    icon: Bot,
    webm: agentWebm,
    mp4: agentMp4,
    poster: agentPoster,
  },
];
