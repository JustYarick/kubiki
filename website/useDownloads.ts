import { useEffect, useState } from 'react';
import { detectPlatform, parseRelease, RELEASE_API, type Platform, type Release } from './downloads';

type HintedNavigator = Navigator & { userAgentData?: { getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }> } };

export function useDownloads() {
  const [release, setRelease] = useState<Release | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detected, setDetected] = useState<Platform>(() => detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
  const [manual, setManual] = useState<Platform | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    fetch(RELEASE_API, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
      .then(response => { if (!response.ok) throw new Error('Release unavailable'); return response.json(); })
      .then(parseRelease)
      .then(value => { if (active) { setRelease(value); setStatus('ready'); } })
      .catch(() => { if (active) setStatus('error'); })
      .finally(() => window.clearTimeout(timeout));
    const hints = (navigator as HintedNavigator).userAgentData;
    hints?.getHighEntropyValues(['architecture', 'bitness']).then(value => {
      if (!active) return;
      const arch = value.architecture === 'arm' && value.bitness === '64' ? 'arm64' : value.architecture === 'x86' && value.bitness === '64' ? 'x64' : null;
      if (arch) setDetected(previous => ({ ...previous, arch }));
    }).catch(() => {});
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, []);
  return { release, status, platform: manual ?? detected, selectPlatform: setManual };
}
