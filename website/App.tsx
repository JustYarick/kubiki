import { ArrowDown, ExternalLink, GitFork } from 'lucide-react';
import logo from '../public/brand/kubiki-logo-color-dark.svg';
import { preferredDownload, RELEASES, type OS } from './downloads';
import { useDownloads } from './useDownloads';
import { HeroSection } from './components/HeroSection';
import { DiagnosticsBento } from './components/DiagnosticsBento';
import { ConnectedSection } from './components/ConnectedSection';
import { IssuesSection } from './components/IssuesSection';
import { InfrastructureSection } from './components/InfrastructureSection';
import { FaqSection } from './components/FaqSection';
import { DownloadFinale } from './components/DownloadFinale';

const REPO = 'https://github.com/JustYarick/kubiki';
const DOCS = `${REPO}/tree/main/docs`;
const OS_LABELS: Record<OS, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

export default function App() {
  const { release, status, platform, selectPlatform } = useDownloads();
  const recommended = preferredDownload(release, platform);
  const downloadLabel = recommended ? `Download for ${OS_LABELS[recommended.os]}` : 'Download Kubiki';
  const downloadHref = recommended?.url ?? '#download';

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <header className="kb-navbar">
        <div className="kb-container kb-nav-inner">
          <div className="kb-nav-left">
            <a className="kb-brand" href="#" aria-label="Kubiki home">
              <img src={logo} width="112" height="40" alt="Kubiki" />
            </a>
            <nav aria-label="Main navigation">
              <a href="#diagnostics">Diagnostics</a>
              <a href="#workspace">Workspace</a>
              <a href="#capabilities">Resources</a>
              <a href="#agents">AI &amp; MCP</a>
              <a href={DOCS}>
                Docs <ExternalLink size={12} />
              </a>
            </nav>
          </div>

          <div className="kb-nav-right">
            <a className="kb-nav-ghost" href={REPO}>
              <GitFork size={14} />
              <span>GitHub</span>
            </a>
            <a className="kb-nav-cta" href={downloadHref}>
              <span>Download</span>
              <ArrowDown size={13} />
            </a>
          </div>
        </div>
      </header>

      <main id="main">
        <HeroSection
          version={release?.version ?? null}
          downloadLabel={downloadLabel}
          downloadHref={downloadHref}
          repoUrl={REPO}
        />

        <DiagnosticsBento />

        <ConnectedSection />

        <IssuesSection />

        <InfrastructureSection />

        <FaqSection />

        <DownloadFinale
          release={release}
          status={status}
          platform={platform}
          selectPlatform={selectPlatform}
        />
      </main>

      <footer className="kb-footer">
        <div className="kb-container">
          <div className="kb-footer-grid">
            <div className="kb-footer-brand">
              <img src={logo} width="108" height="38" alt="Kubiki" />
              <p>
                First-class desktop workspace for Kubernetes clusters.<br />
                Direct kubeconfig access with zero cloud proxy.
              </p>
              <div className="kb-footer-status">
                <a className="kb-status-pill" href={RELEASES}>
                  <span className="status-dot" />
                  <span>{release ? `${release.version} · Stable release` : 'Open source · Apache 2.0'}</span>
                </a>
              </div>
            </div>

            <div className="kb-footer-cols">
              <div>
                <h4>Workspace</h4>
                <a href="#diagnostics">Diagnostics</a>
                <a href="#workspace">Topology &amp; YAML</a>
                <a href="#capabilities">Env &amp; Drift</a>
                <a href="#agents">AI &amp; MCP</a>
              </div>
              <div>
                <h4>Documentation</h4>
                <a href={DOCS}>Documentation</a>
                <a href={`${REPO}/blob/main/docs/AI_AGENT.md`}>AI Agent Guide</a>
                <a href={`${REPO}/blob/main/docs/EXTENSIONS.md`}>Extensions SDK</a>
                <a href={`${REPO}/blob/main/docs/TESTING.md`}>Testing</a>
              </div>
              <div>
                <h4>Project</h4>
                <a href={REPO}>GitHub</a>
                <a href={RELEASES}>Releases</a>
                <a href={`${REPO}/issues`}>Issues</a>
                <a href={`${REPO}/blob/main/LICENSE`}>Apache 2.0 License</a>
              </div>
            </div>
          </div>

          <div className="kb-footer-bottom">
            <span>Built for the people behind the clusters.</span>
            <a href={`${REPO}/blob/main/LICENSE`}>Apache 2.0</a>
          </div>
        </div>
      </footer>
    </>
  );
}
