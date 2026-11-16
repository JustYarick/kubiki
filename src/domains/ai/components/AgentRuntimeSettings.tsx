import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import {
  externalAgentName,
  type AgentRuntime,
  type ExternalTerminalMode,
  type OpenCodeSettings,
} from '../types';
import { AgentEnvironmentSettings } from './AgentEnvironmentSettings';
import { HistorySettings } from './PreferencePanels';

export function AgentRuntimeSettings() {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const runtime = settings.runtime ?? 'kubiki';
  const key = runtime === 'codex' ? 'codex' : runtime === 'claude' ? 'claude' : 'opencode';
  const name = externalAgentName(runtime);
  const initialDraft: OpenCodeSettings = {
    executable: settings[key]?.executable ?? '',
    workingDirectory: settings[key]?.workingDirectory ?? '',
    terminalMode: settings[key]?.terminalMode ?? 'embedded',
    terminalExecutable: settings[key]?.terminalExecutable ?? '',
  };
  const [draft, setDraft] = useState<OpenCodeSettings>(initialDraft);
  const [instructionsDraft, setInstructionsDraft] = useState(settings.instructions ?? '');
  const [detectedTerminal, setDetectedTerminal] = useState<{ label: string; executable: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setDraft({
      executable: settings[key]?.executable ?? '',
      workingDirectory: settings[key]?.workingDirectory ?? '',
      terminalMode: settings[key]?.terminalMode ?? 'embedded',
      terminalExecutable: settings[key]?.terminalExecutable ?? '',
    });
  }, [settings[key], key]);

  useEffect(() => {
    setInstructionsDraft(settings.instructions ?? '');
  }, [settings.instructions]);

  useEffect(() => {
    if (runtime === 'kubiki' || !desktopAiAvailable()) {
      setDetectedTerminal(null);
      return;
    }
    let cancelled = false;
    void agentTransport
      .detectSystemTerminal(draft.terminalExecutable)
      .then(info => { if (!cancelled) setDetectedTerminal(info); })
      .catch(() => { if (!cancelled) setDetectedTerminal(null); });
    return () => { cancelled = true; };
  }, [runtime, draft.terminalExecutable]);

  async function save(nextRuntime = settings.runtime ?? 'kubiki') {
    setError('');
    setMessage('');
    const current = useAiStore.getState().settings;
    try {
      await useAiStore.getState().save({
        ...current,
        runtime: nextRuntime,
        [key]: draft,
      });
      setMessage('Agent settings saved.');
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function saveInstructions() {
    setError('');
    setMessage('');
    const current = useAiStore.getState().settings;
    try {
      await useAiStore.getState().save({
        ...current,
        instructions: instructionsDraft,
      });
      setMessage('Instructions saved.');
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function test() {
    setError('');
    setMessage('');
    setTesting(true);
    try {
      const info = runtime === 'open_code'
        ? await agentTransport.testOpenCode(draft)
        : await agentTransport.testExternalAgent(runtime, draft);
      setMessage(`${info.version} · ${info.executable}`);
    } catch (e) {
      setError(agentError(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="ai-settings-section" aria-label="Agent selection">
      <div className="ai-section-header">
        <div>
          <h3>Agent</h3>
          <p className="ai-help">
            {runtime !== 'kubiki'
              ? `Use your installed ${name} with Kubiki's cluster connection and MCP tools.`
              : 'Choose the active runtime, custom instructions, skills, and local history.'}
          </p>
        </div>
      </div>

      <div className="ai-settings-card">
        <div className="ai-setting-row">
          <div className="ai-setting-row-label">
            <div className="ai-setting-row-title">Use agent</div>
            <p className="ai-help">
              {runtime !== 'kubiki'
                ? `${name} manages its own models and prompts.`
                : 'Integrated Kubiki agent using your saved connections and rules.'}
            </p>
          </div>
          <div className="ai-setting-row-control">
            <Select
              className="ide-select w-44"
              aria-label="AI agent"
              value={settings.runtime ?? 'kubiki'}
              disabled={saving || !desktopAiAvailable()}
              onChange={e => void save(e.target.value as AgentRuntime)}
            >
              <option value="kubiki">Kubiki</option>
              <option value="open_code">OpenCode</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </Select>
          </div>
        </div>
      </div>

      {runtime !== 'kubiki' && (
        <div className="ai-settings-card flex flex-col gap-3">
          <div className="ai-form-grid">
            <label className="ai-field">
              Terminal host
              <Select
                className="ide-select"
                aria-label="Terminal host"
                value={draft.terminalMode ?? 'embedded'}
                onChange={e => setDraft({ ...draft, terminalMode: e.target.value as ExternalTerminalMode })}
              >
                <option value="embedded">Embedded terminal (Kubiki)</option>
                <option value="system">System default terminal</option>
              </Select>
            </label>

            {draft.terminalMode === 'system' && (
              <label className="ai-field">
                System terminal executable
                <Input
                  aria-label="System terminal executable"
                  value={draft.terminalExecutable ?? ''}
                  placeholder={detectedTerminal ? `Auto: ${detectedTerminal.label}` : 'Auto-detect system terminal'}
                  onChange={e => setDraft({ ...draft, terminalExecutable: e.target.value })}
                />
              </label>
            )}

            <label className="ai-field">
              {name} executable
              <Input
                aria-label={`${name} executable`}
                value={draft.executable}
                placeholder={`Find ${runtime === 'open_code' ? 'opencode' : runtime} on PATH`}
                onChange={e => setDraft({ ...draft, executable: e.target.value })}
              />
            </label>

            <label className="ai-field">
              {name} working directory
              <Input
                aria-label={`${name} working directory`}
                value={draft.workingDirectory}
                placeholder="Kubiki default directory"
                onChange={e => setDraft({ ...draft, workingDirectory: e.target.value })}
              />
            </label>
          </div>

          <div className="ai-form-line pt-1">
            <Button size="md" disabled={saving || testing || !desktopAiAvailable()} onClick={() => void test()}>
              Check installation
            </Button>
            <Button size="md" variant="primary" disabled={saving || testing || !desktopAiAvailable()} onClick={() => void save()}>
              <Save size={12} aria-hidden="true" />
              Save {name} settings
            </Button>
          </div>
        </div>
      )}

      <div className="ai-settings-card flex flex-col gap-2.5">
        <div className="ai-card-header">
          <div>
            <h4>Kubiki Agent · Instructions</h4>
            <p className="ai-help">Set a response language or investigation style for the built-in Kubiki Agent. Always editable even when another runtime tab is selected.</p>
          </div>
          <Button
            size="sm"
            disabled={saving || !desktopAiAvailable() || instructionsDraft === (settings.instructions ?? '')}
            onClick={() => void saveInstructions()}
          >
            <Save size={12} aria-hidden="true" />
            Save instructions
          </Button>
        </div>
        <label className="ai-field">
          <span className="sr-only">Agent instructions</span>
          <textarea
            aria-label="Integrated agent instructions"
            className="ide-textarea"
            rows={3}
            maxLength={8000}
            value={instructionsDraft}
            placeholder="For example: answer in Russian and check Pod events first."
            onChange={e => setInstructionsDraft(e.target.value)}
          />
        </label>
      </div>

      <AgentEnvironmentSettings />
      <HistorySettings />

      {message && <p role="status" className="ai-help text-emerald-400 mt-2">{message}</p>}
      {error && <p role="alert" className="ai-error mt-2">{error}</p>}
    </section>
  );
}
