import { ArrowDown, Download, ExternalLink } from 'lucide-react';
import mark from '../../public/brand/kubiki-mark-color.svg';
import { preferredDownload, RELEASES, type Architecture, type OS, type Platform, type Release } from '../downloads';

const OS_LABELS: Record<OS, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

type DownloadFinaleProps = {
  release: Release | null;
  status: 'loading' | 'ready' | 'error';
  platform: Platform;
  selectPlatform: (next: Platform) => void;
};

const GRAPH_NODES = [
  { x: 145, y: 96, kind: 'Ingress', color: '#73daca' },
  { x: 430, y: 88, kind: 'Service', color: '#73daca' },
  { x: 745, y: 155, kind: 'Deployment', color: '#b39aff' },
  { x: 715, y: 345, kind: 'Pod', color: '#b39aff' },
  { x: 185, y: 600, kind: 'ConfigMap', color: '#56c8d8' },
  { x: 525, y: 590, kind: 'Node', color: '#7e9fff' },
  { x: 1185, y: 90, kind: 'Helm', color: '#4ec9b0' },
  { x: 1295, y: 604, kind: 'MCP', color: '#3574f0' },
];

const GRAPH_EDGES = [
  { d: 'M 145 96 C 285 96, 290 88, 430 88', color: '#73daca', delay: '0s' },
  { d: 'M 430 88 C 585 88, 595 155, 745 155', color: '#b39aff', delay: '-0.9s' },
  { d: 'M 745 155 C 745 250, 715 250, 715 345', color: '#b39aff', delay: '-1.7s' },
  { d: 'M 185 600 C 355 600, 355 590, 525 590', color: '#56c8d8', delay: '-2.3s' },
  { d: 'M 525 590 C 625 590, 625 345, 715 345', color: '#7e9fff', delay: '-1.1s' },
  { d: 'M 1185 90 C 965 90, 965 155, 745 155', color: '#4ec9b0', delay: '-0.5s' },
  { d: 'M 715 345 C 1005 345, 1005 604, 1295 604', color: '#3574f0', delay: '-1.9s' },
];

export function DownloadFinale({ release, status, platform, selectPlatform }: DownloadFinaleProps) {
  const recommended = preferredDownload(release, platform);
  const formatRank = ['DMG', 'EXE', 'AppImage', 'DEB', 'RPM', 'MSI'];
  const options =
    release?.downloads
      .filter(item => item.os === platform.os && (!platform.arch || item.arch === platform.arch))
      .sort((a, b) => formatRank.indexOf(a.format) - formatRank.indexOf(b.format) || a.arch.localeCompare(b.arch)) ?? [];

  return (
    <section id="download" className="kb-finale-band">
      {/* Animated Kubiki Topology Backdrop */}
      <svg
        className="kb-finale-svg"
        viewBox="0 0 1440 680"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="kbFinaleGlow" cx="34%" cy="50%" r="55%">
            <stop offset="0%" stopColor="#3574f0" stopOpacity="0.16" />
            <stop offset="50%" stopColor="#9b7aea" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#121316" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1440" height="680" fill="url(#kbFinaleGlow)" />

        <g className="kb-finale-edges">
          {GRAPH_EDGES.map((edge, i) => (
            <g key={i}>
              <path d={edge.d} stroke="rgba(255,255,255,0.06)" strokeWidth="1.2" strokeDasharray="4 4" />
              <path
                d={edge.d}
                className="kb-finale-pulse"
                stroke={edge.color}
                strokeWidth="1.8"
                style={{ animationDelay: edge.delay }}
              />
            </g>
          ))}
        </g>

        <g className="kb-finale-nodes">
          {GRAPH_NODES.map(node => {
            const labelW = node.kind.length * 6.8;
            const groupW = 14 + labelW;
            const boxW = Math.max(82, Math.ceil(groupW + 28));
            return (
              <g key={node.kind} transform={`translate(${node.x}, ${node.y})`}>
                <rect
                  x={-boxW / 2}
                  y="-15"
                  width={boxW}
                  height="30"
                  rx="5"
                  fill="#1e1f22"
                  stroke="#32353a"
                />
                <circle cx={-groupW / 2 + 3.5} cy="0" r="3.5" fill={node.color} opacity="0.85" />
                <text
                  x={-groupW / 2 + 14}
                  y="4"
                  fill="rgba(223, 225, 229, 0.55)"
                  fontSize="11"
                  fontFamily='"JetBrains Mono Variable", "JetBrains Mono", monospace'
                >
                  {node.kind}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="kb-container kb-finale-inner">
        <div className="kb-download-copy">
          <div className="kb-download-mark">
            <img src={mark} width="42" height="42" alt="" />
          </div>
          <h2>One calm workspace for every cluster.</h2>
          <p>
            Download Kubiki for macOS, Windows or Linux. Point it at your local kubeconfig and inspect workloads, topology, Helm and AI investigations in seconds.
          </p>
          <div className="kb-release-line">
            <span className="status-dot" />
            <span>
              {release
                ? `${release.version} · Latest stable release`
                : status === 'error'
                  ? 'Installers available on GitHub Releases'
                  : 'Checking latest stable release…'}
            </span>
          </div>
        </div>

        <div className="kb-download-card">
          <div className="kb-dl-head">
            <h3>Get Kubiki</h3>
            {recommended && (
              <a className="kb-dl-quick" href={recommended.url}>
                <Download size={13} />
                <span>{recommended.format}</span>
              </a>
            )}
          </div>

          <div className="kb-os-picker" role="group" aria-label="Operating system">
            {(['macos', 'windows', 'linux'] as OS[]).map(os => (
              <button
                key={os}
                type="button"
                aria-pressed={platform.os === os}
                onClick={() => selectPlatform({ os, arch: null })}
              >
                {OS_LABELS[os]}
              </button>
            ))}
          </div>

          <label className="kb-arch-label" htmlFor="architecture">Architecture</label>
          <select
            id="architecture"
            value={platform.arch ?? ''}
            onChange={e =>
              selectPlatform({
                ...platform,
                arch: (e.target.value as Architecture) || null,
              })
            }
          >
            <option value="">All architectures</option>
            <option value="arm64">
              {platform.os === 'macos' ? 'Apple Silicon (M series)' : 'ARM64'}
            </option>
            <option value="x64">
              {platform.os === 'macos' ? 'Intel (x86_64)' : 'Intel / AMD (x64)'}
            </option>
          </select>

          <div className="kb-dl-options" aria-live="polite">
            {!platform.os ? (
              <p className="kb-dl-hint">Choose your desktop operating system to see installers.</p>
            ) : status === 'loading' ? (
              <p className="kb-dl-hint">Finding the latest installers…</p>
            ) : options.length ? (
              options.map(item => (
                <a className="kb-pkg-link" href={item.url} key={item.name}>
                  <span>
                    <Download size={15} />
                    <strong>{item.format}</strong>
                    <small>
                      {OS_LABELS[item.os]} ·{' '}
                      {item.os === 'macos'
                        ? item.arch === 'arm64'
                          ? 'Apple Silicon (ARM64)'
                          : 'Intel (x64)'
                        : item.arch === 'arm64'
                          ? 'ARM64'
                          : 'x64'}
                    </small>
                  </span>
                  <span className="kb-pkg-size">
                    {Math.round(item.size / 1024 / 1024)} MB
                    <ArrowDown size={13} />
                  </span>
                </a>
              ))
            ) : (
              <p className="kb-dl-hint">
                {status === 'error'
                  ? 'Couldn’t reach GitHub. You can still download directly from the release page.'
                  : platform.arch
                    ? 'No installer for this architecture in the latest stable release. Choose another architecture or browse releases.'
                    : 'No installer for this operating system in the latest stable release. Browse releases directly.'}
              </p>
            )}
          </div>

          <a className="kb-all-releases" href={RELEASES}>
            All releases &amp; checksums <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </section>
  );
}
