import { useEffect } from 'react';
import { Download } from 'lucide-react';
import { appUpdates, useAppUpdates } from '../../state/update_store';
import { useUiStore } from '../../state/ui_store';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

/** Startup is independent of cluster discovery and does not block first paint. */
export function AppUpdatePrompt() {
  useEffect(() => {
    const timer = window.setTimeout(() => { void appUpdates.startup(); }, 1500);
    return () => window.clearTimeout(timer);
  }, []);
  const { phase, dialogOpen } = useAppUpdates();
  const update = 'update' in phase ? phase.update : undefined;
  const downloading = phase.status === 'downloading';
  const installing = phase.status === 'installing';
  const canInstall = phase.status === 'downloaded' || (phase.status === 'error' && phase.stage === 'install');
  const canDownload = phase.status === 'available' || (phase.status === 'error' && phase.stage === 'download');
  const total = downloading ? phase.progress.total : undefined;
  const percent = downloading && total ? Math.min(100, Math.round(phase.progress.downloaded / total * 100)) : undefined;
  return <>
    {update && !dialogOpen && (downloading || canInstall) && <div role="status" className="fixed bottom-10 right-4 z-[80] w-[calc(340px*var(--ui-factor))] max-w-[calc(100vw-32px)] rounded-md border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-popup)]">
      <div className="flex items-center gap-2 text-xs font-medium"><Download size={14} aria-hidden="true" />Kubiki {update.version} is available</div>
      <div className="mt-2 flex justify-end gap-2"><Button size="sm" onClick={() => appUpdates.open()}>View update</Button></div>
    </div>}
    <Modal open={dialogOpen} onClose={() => appUpdates.close()} title={update ? `Update Kubiki to ${update.version}` : 'Kubiki updates'} width={540} footer={<>
      {phase.status === 'available' && <Button size="sm" variant="ghost" onClick={() => appUpdates.skip()}>Skip this version</Button>}
      <span className="flex-1" />
      <Button size="sm" disabled={installing} onClick={() => appUpdates.later()}>{update ? 'Later' : 'Close'}</Button>
      {canDownload && <Button size="sm" variant="primary" onClick={() => { void appUpdates.download(); }}>Download update</Button>}
      {canInstall && <Button size="sm" variant="primary" onClick={() => { void appUpdates.install(); }}>Install and restart</Button>}
      {(phase.status === 'upToDate' || (phase.status === 'error' && phase.stage === 'check')) && <Button size="sm" onClick={() => { void appUpdates.check(); }}>Check again</Button>}
    </>}>
      <div className="space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
        {update && <p>Installed: {update.currentVersion} · Available: {update.version} · {/-dev(?:\.\d+)?$/.test(update.currentVersion) ? 'Dev' : 'Stable'} channel</p>}
        {phase.status === 'checking' && <p role="status">Checking for updates in this build’s channel…</p>}
        {phase.status === 'upToDate' && <p role="status">You are using the latest version in this update channel.</p>}
        {phase.status === 'disabled' && <p role="status">{phase.reason}</p>}
        {phase.status === 'error' && <p role="alert" className="text-[var(--status-danger)]">{phase.message}</p>}
        {update?.notes && <div className="whitespace-pre-wrap break-words max-h-56 overflow-y-auto kubiki-scrollbar rounded border border-[var(--border-subtle)] p-3">{update.notes}</div>}
        {downloading && <div role="status">
          <p>Downloading update{percent === undefined ? '…' : `: ${percent}%`}</p>
          <progress aria-label="Update download progress" max={100} value={percent} className="w-full mt-2 accent-[var(--accent-fill)]" />
        </div>}
        {canInstall && <>
          <p>The update is downloaded and its signature has been verified.</p>
          <p>Save or revert unsaved YAML edits before installing. Restarting closes terminals, log streams and port forwards. Wait for running cluster changes to finish.</p>
        </>}
        {installing && <p role="status">Installing the update and restarting Kubiki…</p>}
      </div>
    </Modal>
  </>;
}

export function UpdateSettings() {
  const { phase } = useAppUpdates();
  const busy = ['checking', 'downloading', 'installing'].includes(phase.status);
  const update = 'update' in phase ? phase.update : undefined;
  return <div className="space-y-2">
    <p className="text-xs text-[var(--text-muted)]" role="status">
      {phase.status === 'disabled' ? phase.reason : phase.status === 'upToDate' ? 'You are using the latest version in this update channel.' : update ? `Kubiki ${update.version} is available.` : phase.status === 'error' ? phase.message : 'Checks for newer releases in this build’s channel when Kubiki starts. Dev builds receive dev updates; stable builds receive stable updates.'}
    </p>
    <Button size="sm" disabled={busy} onClick={() => {
      useUiStore.getState().setSettingsOpen(false);
      if (update) appUpdates.open();
      else void appUpdates.check();
    }}>{busy ? phase.status === 'checking' ? 'Checking…' : phase.status === 'downloading' ? 'Downloading…' : 'Installing…' : update ? 'View update' : 'Check for updates'}</Button>
  </div>;
}
