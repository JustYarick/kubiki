import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, GitFork, Play, X } from 'lucide-react';
import mark from '../../public/brand/kubiki-mark-color.svg';
import overviewWebm from '../media/overview.webm';
import overviewMp4 from '../media/overview.mp4';
import overviewPoster from '../media/overview.webp';
import overviewSmall from '../media/overview-960.webp';
import { stageScenes } from './scenes';

type HeroSectionProps = {
  version: string | null;
  downloadLabel: string;
  downloadHref: string;
  repoUrl: string;
};

export function HeroSection({ version, downloadLabel, downloadHref, repoUrl }: HeroSectionProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalScene, setModalScene] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false);
      if (e.key === 'ArrowRight') setModalScene(i => (i + 1) % stageScenes.length);
      if (e.key === 'ArrowLeft') setModalScene(i => (i - 1 + stageScenes.length) % stageScenes.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  const activeModal = stageScenes[modalScene];

  return (
    <section className="kb-hero">
      <div className="kb-beam-mask" aria-hidden="true">
        <div className="beam-background" />
      </div>
      <div className="kb-hero-radial" aria-hidden="true" />

      <div className="kb-container kb-hero-inner">
        <div className="kb-hero-copy">
          <h1>
            <span className="blur-up">Your cluster.</span>
            <span className="blur-up blur-up-d1">Finally, in focus.</span>
          </h1>
          <p className="blur-up blur-up-d2">
            Kubiki is a native Kubernetes workspace built for real investigations.
            Resource tables, topology, YAML splits, Helm and scoped AI—all in one window.
          </p>
          <div className="kb-hero-actions blur-up blur-up-d3">
            <a className="kb-btn kb-btn-primary" href={downloadHref}>
              <Download size={16} />
              <span>{downloadLabel}</span>
            </a>
            <a className="kb-btn kb-btn-ghost" href={repoUrl}>
              <GitFork size={16} />
              <span>{version ? `${version} · GitHub` : 'View on GitHub'}</span>
            </a>
          </div>
        </div>

        <div className="kb-hero-stage">
          <div className="kb-hero-frame">
            {reducedMotion ? (
              <img
                className="kb-hero-media"
                src={overviewPoster}
                srcSet={`${overviewSmall} 960w, ${overviewPoster} 1440w`}
                sizes="(max-width: 768px) calc(100vw - 32px), 1280px"
                width={1440}
                height={900}
                alt="Kubiki cluster overview workspace"
              />
            ) : (
              <video
                className="kb-hero-media"
                autoPlay
                loop
                muted
                playsInline
                poster={overviewPoster}
                width={1440}
                height={900}
              >
                <source src={overviewWebm} type="video/webm" />
                <source src={overviewMp4} type="video/mp4" />
              </video>
            )}

            <button
              type="button"
              className="kb-watch-pill"
              onClick={() => {
                setModalScene(0);
                setModalOpen(true);
              }}
            >
              <span className="kb-watch-icon">
                <Play size={12} fill="currentColor" />
              </span>
              <span>Kubiki in action</span>
            </button>
          </div>
        </div>
      </div>

      {modalOpen &&
        createPortal(
          <div
            className="kb-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Kubiki demo walkthrough"
            onClick={() => setModalOpen(false)}
          >
            <div className="kb-modal" onClick={e => e.stopPropagation()}>
              <div className="kb-modal-bar">
                <div className="kb-modal-title">
                  <img src={mark} width="15" height="15" alt="" />
                  <strong>{activeModal.name}</strong>
                  <span>{activeModal.breadcrumb}</span>
                </div>
                <div className="kb-modal-tabs">
                  {stageScenes.map((item, idx) => (
                    <button
                      key={item.id}
                      type="button"
                      className={idx === modalScene ? 'active' : ''}
                      onClick={() => setModalScene(idx)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="kb-modal-close"
                  onClick={() => setModalOpen(false)}
                  aria-label="Close preview"
                >
                  <X size={16} />
                </button>
              </div>
              <video
                key={`modal-${activeModal.id}`}
                className="kb-modal-video"
                autoPlay={!reducedMotion}
                loop
                muted
                playsInline
                controls
                poster={activeModal.poster}
              >
                <source src={activeModal.webm} type="video/webm" />
                <source src={activeModal.mp4} type="video/mp4" />
              </video>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
