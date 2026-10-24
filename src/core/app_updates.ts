import { createStore } from 'zustand/vanilla';

export interface AppUpdate {
  version: string;
  currentVersion: string;
  notes: string;
}
export interface UpdateProgress { downloaded: number; total?: number | null }
export type UpdateCheck =
  | { status: 'disabled'; reason: string }
  | { status: 'upToDate' }
  | { status: 'available'; update: AppUpdate };
export interface UpdateAdapter {
  check(): Promise<UpdateCheck>;
  download(version: string, progress: (value: UpdateProgress) => void): Promise<void>;
  install(version: string): Promise<void>;
}
export interface UpdatePreferences {
  skippedVersion?: string;
  remindAfter?: number;
}
export type UpdatePhase =
  | { status: 'idle' | 'checking' | 'upToDate' }
  | { status: 'disabled'; reason: string }
  | { status: 'available' | 'downloaded' | 'installing'; update: AppUpdate }
  | { status: 'downloading'; update: AppUpdate; progress: UpdateProgress }
  | { status: 'error'; message: string; stage: 'check' | 'download' | 'install'; update?: AppUpdate };
export interface UpdateState { phase: UpdatePhase; dialogOpen: boolean }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One coordinator per app session. The adapter owns package I/O; this service
 * owns transitions and notification preferences, independently of React. */
export class UpdateService {
  readonly store = createStore<UpdateState>(() => ({ phase: { status: 'idle' }, dialogOpen: false }));
  private operation?: Promise<void>;
  private startupChecked = false;

  constructor(
    private readonly adapter: UpdateAdapter,
    private readonly preferences: { read(): UpdatePreferences; write(value: UpdatePreferences): void },
    private readonly beforeInstall: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** StrictMode and remounts must not duplicate startup requests or prompts. */
  startup() {
    if (this.startupChecked) return this.operation ?? Promise.resolve();
    this.startupChecked = true;
    return this.check(false);
  }

  check(manual = true): Promise<void> {
    if (this.operation) {
      if (manual) this.open();
      return this.operation;
    }
    const current = this.store.getState().phase;
    if (current.status === 'downloaded' || current.status === 'installing') {
      if (manual) this.open();
      return Promise.resolve();
    }
    this.store.setState({ phase: { status: 'checking' }, dialogOpen: manual });
    return this.run(async () => {
      try {
        const result = await this.adapter.check();
        const preference = this.preferences.read();
        const suppressed = result.status === 'available' &&
          (preference.skippedVersion === result.update.version || (preference.remindAfter ?? 0) > this.now());
        // A manual request during the background check also overrides suppression.
        const requested = this.store.getState().dialogOpen;
        this.store.setState({ phase: result, dialogOpen: requested || (!suppressed && result.status === 'available') });
      } catch (error) {
        this.store.setState({ phase: { status: 'error', stage: 'check', message: message(error) } });
      }
    });
  }

  download(): Promise<void> {
    if (this.operation) return this.operation;
    const phase = this.store.getState().phase;
    if (phase.status !== 'available' && !(phase.status === 'error' && phase.stage === 'download')) return Promise.resolve();
    const update = phase.update;
    if (!update) return Promise.resolve();
    this.store.setState({ phase: { status: 'downloading', update, progress: { downloaded: 0 } }, dialogOpen: true });
    return this.run(async () => {
      try {
        await this.adapter.download(update.version, progress => {
          this.store.setState({ phase: { status: 'downloading', update, progress } });
        });
        this.store.setState({ phase: { status: 'downloaded', update } });
      } catch (error) {
        this.store.setState({ phase: { status: 'error', stage: 'download', message: message(error), update } });
      }
    });
  }

  install(): Promise<void> {
    if (this.operation) return this.operation;
    const phase = this.store.getState().phase;
    if (phase.status !== 'downloaded' && !(phase.status === 'error' && phase.stage === 'install')) return Promise.resolve();
    const update = phase.update;
    if (!update) return Promise.resolve();
    return this.run(async () => {
      try {
        this.beforeInstall();
        this.store.setState({ phase: { status: 'installing', update }, dialogOpen: true });
        await this.adapter.install(update.version);
      } catch (error) {
        this.store.setState({ phase: { status: 'error', stage: 'install', message: message(error), update }, dialogOpen: true });
      }
    });
  }

  open() { this.store.setState({ dialogOpen: true }); }
  close() {
    if (this.store.getState().phase.status !== 'installing') this.store.setState({ dialogOpen: false });
  }
  later() {
    this.preferences.write({ ...this.preferences.read(), remindAfter: this.now() + 24 * 60 * 60 * 1000 });
    this.close();
  }
  skip() {
    const phase = this.store.getState().phase;
    if (phase.status !== 'available') return;
    this.preferences.write({ skippedVersion: phase.update.version });
    this.close();
  }

  private run(task: () => Promise<void>) {
    // Defer execution until the single-flight reservation has been assigned.
    const operation = Promise.resolve().then(task).finally(() => { this.operation = undefined; });
    this.operation = operation;
    return operation;
  }
}
