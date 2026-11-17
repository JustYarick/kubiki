import { useState } from 'react';
import { Plus } from 'lucide-react';

const FAQS = [
  {
    q: 'Does Kubiki require kubectl to inspect clusters, logs or shells?',
    a: 'No. Resource reads, watches, container logs, Pod exec terminals and TCP port forwarding run directly through Kubiki’s Rust Kubernetes client using your kubeconfig. Only Helm actions use your local Helm executable.',
  },
  {
    q: 'How does Kubiki connect to clusters and handle credentials?',
    a: 'Kubiki reads your local ~/.kube/config or KUBECONFIG paths directly on your machine. Credentials, kubeconfigs and Secret values never pass through any remote backend or cloud proxy.',
  },
  {
    q: 'How does Kubiki restrict what AI agents and MCP clients can access?',
    a: 'Every tool invocation runs through Kubiki’s backend policy engine. New conversations default to Plan + Ask (read-only), Secret and ConfigMap bodies are excluded by default, and contexts/namespaces can be scoped independently.',
  },
  {
    q: 'Can I connect Claude Code, Codex or OpenCode to my open cluster?',
    a: 'Yes. Kubiki embeds a loopback Streamable HTTP MCP server with selectable Read-only and Action profiles, and can launch external CLIs directly from a failing Pod with scoped resource identity.',
  },
  {
    q: 'Does Kubiki support Helm, Flux, Argo CD and Custom Resources?',
    a: 'Yes. It includes Helm release inventories, revision history, values and rollbacks; Flux and Argo CD reconciliation tracking; automatic CRD discovery; and an isolated Node.js extension runtime.',
  },
  {
    q: 'Which desktop platforms and installers are available?',
    a: 'Native desktop releases ship for macOS (Apple Silicon DMG and Intel DMG), Windows (NSIS EXE and MSI) and Linux (AppImage, DEB and RPM), with separate stable and dev update channels.',
  },
];

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="kb-closing-faq" id="faq">
      <div className="kb-container">
        <div className="kb-faq-wrap">
          <h2>FAQs</h2>
          <div className="kb-faq-list">
            {FAQS.map((item, idx) => {
              const open = openIndex === idx;
              return (
                <div key={item.q} className={open ? 'kb-faq-item open' : 'kb-faq-item'}>
                  <button
                    type="button"
                    className="kb-faq-trigger"
                    aria-expanded={open}
                    onClick={() => setOpenIndex(open ? null : idx)}
                  >
                    <span>{item.q}</span>
                    <Plus size={16} className="kb-faq-plus" />
                  </button>
                  <div className="kb-faq-body-wrap">
                    <div className="kb-faq-body">
                      <p>{item.a}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
