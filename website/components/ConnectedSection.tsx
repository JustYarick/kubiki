import { useEffect, useState } from 'react';
import {
  Anchor,
  ArrowRightLeft,
  Blocks,
  Boxes,
  Braces,
  GitBranch,
  Key,
  Terminal,
  Workflow,
} from 'lucide-react';
import mark from '../../public/brand/kubiki-mark-color.svg';
import { stageScenes } from './scenes';

const RESOURCES = [
  { title: 'Workloads & Health', desc: 'Inspect Pods, Deployments, StatefulSets, DaemonSets and Jobs with real rollout counts.', icon: Boxes, tone: 'blue' },
  { title: 'Resource Topology', desc: 'ELK-arranged graphs linking workloads, Services, Ingresses, NetworkPolicies and PVCs.', icon: GitBranch, tone: 'purple' },
  { title: 'YAML & Split Panes', desc: 'Monaco editor with clean manifest mode, formatting, drafts and side-by-side splits.', icon: Braces, tone: 'blue' },
  { title: 'Logs & Pod Shells', desc: 'Stream container logs, attach interactive shells, launch node debug Pods or local terminals.', icon: Terminal, tone: 'purple' },
  { title: 'Port Forwarding', desc: 'Bind local 127.0.0.1 TCP tunnels to Pods or Services and manage active sessions.', icon: ArrowRightLeft, tone: 'blue' },
  { title: 'Helm Releases', desc: 'Search releases, inspect revision history, compare values, read manifests and roll back.', icon: Anchor, tone: 'purple' },
  { title: 'Flux & Argo CD', desc: 'Track Kustomizations, HelmReleases, Sources and Argo CD sync vs health status.', icon: Workflow, tone: 'blue' },
  { title: 'Env & Secret Drift', desc: 'Resolve valueFrom/envFrom variables without exec, auto-mask Secrets and catch drift.', icon: Key, tone: 'purple' },
  { title: 'CRDs & Master Search', desc: 'Discover custom resources automatically and jump anywhere with Ctrl+K Master Search.', icon: Blocks, tone: 'blue' },
];

export function ConnectedSection() {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const current = stageScenes[sceneIdx];

  return (
    <section className="kb-section kb-connected-band" id="workspace">
      <div className="kb-container">
        <div className="kb-center-head">
          <h2>Every resource, connected together</h2>
          <p>
            Connect every Kubernetes object across your cluster from workloads and Services to Helm revisions, ConfigMaps and Custom Resources in one unified IDE workspace.
          </p>
        </div>

        <div className="kb-matrix-9">
          {RESOURCES.map(item => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="kb-matrix9-card">
                <div className="kb-matrix9-head">
                  <span className={`kb-m9-icon tone-${item.tone}`}>
                    <Icon size={15} />
                  </span>
                  <h3>{item.title}</h3>
                </div>
                <p>{item.desc}</p>
              </article>
            );
          })}
        </div>

        <div className="kb-quote-wrap">
          <div className="kb-quote-box">
            <div className="kb-quote-marks" aria-hidden="true">
              <span /><span />
            </div>
            <blockquote>
              Cluster tools shouldn’t force you to choose between noisy browser dashboards and twenty terminal tabs. Kubiki keeps discovery, live state, manifests and AI in one crisp workspace.
            </blockquote>
            <div className="kb-quote-author">
              <div className="kb-quote-avatar">
                <img src={mark} width="18" height="18" alt="" />
              </div>
              <div>
                <strong>Kubiki Desktop</strong>
                <span>React IDE surface · Rust Kubernetes engine · Apache 2.0</span>
              </div>
            </div>
          </div>
        </div>

        <div className="kb-workspace-showcase">
          <div className="kb-workspace-frame">
            <div className="kb-workspace-sidebar">
              <div className="kb-ws-cluster">
                <img src={mark} width="20" height="20" alt="" />
                <div>
                  <strong>kubiki-demo</strong>
                  <span>184 nodes · All Namespaces</span>
                </div>
              </div>

              <div className="kb-ws-label">CLUSTER EXPLORER</div>
              <div className="kb-ws-nav" role="tablist" aria-label="Workspace scenes">
                {stageScenes.map((scene, idx) => {
                  const Icon = scene.icon;
                  const active = idx === sceneIdx;
                  return (
                    <button
                      key={scene.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={active ? 'active' : ''}
                      onClick={() => setSceneIdx(idx)}
                    >
                      <Icon size={14} />
                      <span>{scene.name}</span>
                    </button>
                  );
                })}
              </div>

              <div className="kb-ws-note">
                <strong>{current.caption}</strong>
                <p>{current.description}</p>
              </div>
            </div>

            <div className="kb-workspace-stage">
              <div className="kb-ws-tabbar">
                <div className="kb-ws-tab active">
                  <span>{current.name}</span>
                </div>
                <span className="kb-ws-breadcrumb">{current.breadcrumb}</span>
                <span className="kb-ws-rec">Demo · ?demo=1</span>
              </div>
              {reducedMotion ? (
                <img
                  key={current.id}
                  className="kb-ws-video"
                  src={current.poster}
                  width={1440}
                  height={900}
                  alt={current.name}
                />
              ) : (
                <video
                  key={current.id}
                  className="kb-ws-video"
                  autoPlay
                  loop
                  muted
                  playsInline
                  poster={current.poster}
                  width={1440}
                  height={900}
                >
                  <source src={current.webm} type="video/webm" />
                  <source src={current.mp4} type="video/mp4" />
                </video>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
