import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type UpdateAdapter, type UpdatePreferences, type UpdateCheck } from '../../src/core/app_updates';

const update = { version: '0.2.1', currentVersion: '0.1.0', notes: 'Stable release' };
function setup(initial: UpdatePreferences = {}) {
  let preference = initial;
  const adapter: UpdateAdapter = {
    check: vi.fn().mockResolvedValue({ status: 'available', update }),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  };
  const beforeInstall = vi.fn();
  const preferences = { read: () => preference, write: (value: UpdatePreferences) => { preference = value; } };
  const service = new UpdateService(adapter, preferences, beforeInstall, () => 1000);
  return { service, adapter, beforeInstall, preferences };
}

describe('desktop update coordinator', () => {
  it('does not block startup or duplicate checks on remount; manual requests join the check', async () => {
    const { service, adapter } = setup({ skippedVersion: update.version });
    let finish!: (value: UpdateCheck) => void;
    vi.mocked(adapter.check).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = service.startup();
    expect(service.startup()).toBe(first);
    expect(service.store.getState().dialogOpen).toBe(false);
    expect(service.check()).toBe(first);
    await vi.waitFor(() => expect(adapter.check).toHaveBeenCalledOnce());
    finish({ status: 'available', update });
    await first;
    expect(service.store.getState()).toMatchObject({ phase: { status: 'available', update }, dialogOpen: true });
  });

  it('suppresses skipped releases automatically but allows explicit checks and newer releases', async () => {
    const { service, adapter } = setup({ skippedVersion: update.version });
    await service.startup();
    expect(service.store.getState().dialogOpen).toBe(false);
    await service.check();
    expect(service.store.getState().dialogOpen).toBe(true);
    service.skip();
    expect(service.store.getState().dialogOpen).toBe(false);
    vi.mocked(adapter.check).mockResolvedValue({ status: 'available', update: { ...update, version: '0.2.2' } });
    await service.check(false);
    expect(service.store.getState().dialogOpen).toBe(true);
  });

  it('remembers Later for a day without suppressing a manual check', async () => {
    const { service, preferences } = setup();
    await service.startup();
    service.later();
    expect(preferences.read().remindAfter).toBe(1000 + 86_400_000);
    await service.check(false);
    expect(service.store.getState().dialogOpen).toBe(false);
    await service.check();
    expect(service.store.getState().dialogOpen).toBe(true);
  });

  it('keeps offline errors quiet at startup and supports retry', async () => {
    const { service, adapter } = setup();
    vi.mocked(adapter.check).mockRejectedValueOnce(new Error('Offline'));
    await service.startup();
    expect(service.store.getState()).toMatchObject({ phase: { status: 'error', stage: 'check', message: 'Offline' }, dialogOpen: false });
    await service.check();
    expect(service.store.getState()).toMatchObject({ phase: { status: 'available' }, dialogOpen: true });
  });

  it('cannot install before verified download; gates restart on unsaved changes and supports retry', async () => {
    const { service, adapter, beforeInstall } = setup();
    await service.startup();
    await service.install();
    expect(adapter.install).not.toHaveBeenCalled();
    vi.mocked(adapter.download).mockImplementationOnce(async (_version, progress) => {
      progress({ downloaded: 50, total: 100 });
      expect(service.store.getState().phase).toMatchObject({ status: 'downloading', progress: { downloaded: 50 } });
    });
    const downloading = service.download();
    expect(service.download()).toBe(downloading);
    await downloading;
    expect(service.store.getState().phase.status).toBe('downloaded');
    beforeInstall.mockImplementationOnce(() => { throw new Error('Unsaved YAML'); });
    await service.install();
    expect(adapter.install).not.toHaveBeenCalled();
    expect(service.store.getState().phase).toMatchObject({ status: 'error', stage: 'install' });
    await service.install();
    expect(adapter.install).toHaveBeenCalledExactlyOnceWith(update.version);
    service.close();
    expect(service.store.getState().dialogOpen).toBe(true);
  });

  it('never installs a failed or unverified download and retains the selected version for retry', async () => {
    const { service, adapter } = setup();
    await service.check();
    vi.mocked(adapter.download).mockRejectedValueOnce(new Error('Invalid signature'));
    await service.download();
    expect(service.store.getState().phase).toMatchObject({ status: 'error', stage: 'download', update });
    await service.install();
    expect(adapter.install).not.toHaveBeenCalled();
    await service.download();
    expect(service.store.getState().phase.status).toBe('downloaded');
  });

  it('preserves a downloaded package when the user checks again', async () => {
    const { service, adapter } = setup();
    await service.check();
    await service.download();
    service.close();
    await service.check();
    expect(adapter.check).toHaveBeenCalledOnce();
    expect(service.store.getState()).toMatchObject({ phase: { status: 'downloaded', update }, dialogOpen: true });
  });

  it('does not announce updates for development, browser, or package-manager builds', async () => {
    const { service, adapter } = setup();
    vi.mocked(adapter.check).mockResolvedValue({ status: 'disabled', reason: 'Development build' });
    await service.startup();
    expect(service.store.getState()).toMatchObject({ phase: { status: 'disabled' }, dialogOpen: false });
  });
});
