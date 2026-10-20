import { useCallback, useEffect, useRef, useState } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import { Copy, Download, RotateCcw, Save } from 'lucide-react';
import { Button, IconButton, Tooltip } from '../components/ui/Button';
import { toast } from '../state/notifications_store';
import type { ResourceItem } from '../types/k8s';
import { k8s } from '../providers/k8s_provider';
import { parse, stringify } from 'yaml';
import { cx } from '../core/utils/cx';
import { useUiStore } from '../state/ui_store';

interface YamlEditorProps {
  item: ResourceItem;
  onApply: (yaml: string) => void;
}

export function YamlEditor({ item, onApply }: YamlEditorProps) {
  const fontSize = useUiStore((state) => state.editorFontSize);
  const original = item.rawYaml ?? '';
  const [draft, setDraft] = useState(original);
  const [ready, setReady] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);
  const draftRef = useRef(draft);
  const previous = useRef({ uid: item.uid, original });
  const dirty = draft !== original;

  const replaceDraft = useCallback((value: string) => {
    draftRef.current = value;
    const model = modelRef.current;
    if (model && !model.isDisposed() && model.getValue() !== value) model.setValue(value);
    setDraft(value);
  }, []);

  // Refresh clean documents; never overwrite a local draft on a background snapshot.
  useEffect(() => {
    const prior = previous.current;
    if (prior.uid !== item.uid || draftRef.current === prior.original) replaceDraft(original);
    previous.current = { uid: item.uid, original };
  }, [item.uid, original, replaceDraft]);

  const apply = useCallback(() => {
    if (draftRef.current === original || !k8s.demo) return;
    try {
      const parsed = parse(draftRef.current);
      if (!parsed || typeof parsed !== 'object' || parsed.metadata?.name !== item.name || parsed.kind !== item.kind || parsed.metadata?.namespace !== item.namespace) {
        throw new Error('The manifest must keep the resource kind, name and namespace.');
      }
      const manifest = stringify(parsed);
      onApply(manifest);
      replaceDraft(manifest);
    } catch (error) {
      toast.error('Invalid YAML manifest', String(error));
    }
  }, [original, item.kind, item.name, item.namespace, onApply, replaceDraft]);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    let disposed = false;
    let instance: editor.IStandaloneCodeEditor | undefined;
    let model: editor.ITextModel | undefined;
    let changes: IDisposable | undefined;
    let saveAction: IDisposable | null = null;
    setReady(false);
    setEditorError('');

    // Monaco owns no React hooks. Every mounted editor owns its model and subscriptions.
    void import('./monaco_setup').then(({ monaco }) => {
      if (disposed || !containerRef.current) return;
      model = monaco.editor.createModel(draftRef.current, 'yaml');
      instance = monaco.editor.create(containerRef.current, {
        model,
        theme: 'kubiki-dark',
        readOnly: !k8s.demo,
        ariaLabel: `YAML for ${item.kind} ${item.name}`,
        fontSize: useUiStore.getState().editorFontSize,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
        fontLigatures: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
        overviewRulerLanes: 0,
        renderWhitespace: 'selection',
        cursorBlinking: 'smooth',
        lineNumbersMinChars: 3,
        guides: { indentation: true },
      });
      editorRef.current = instance;
      modelRef.current = model;
      changes = model.onDidChangeContent(() => {
        if (model && !disposed) {
          // Monaco owns live edits. Never echo an older React render back into the model.
          draftRef.current = model.getValue();
          setDraft(draftRef.current);
        }
      });
      saveAction = instance.addAction({
        id: 'kubiki.applyManifest',
        label: 'Apply manifest',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => applyRef.current(),
      });
      setReady(true);
      instance.focus();
    }).catch((error) => {
      changes?.dispose();
      saveAction?.dispose();
      instance?.dispose();
      model?.dispose();
      if (!disposed) {
        editorRef.current = null;
        modelRef.current = null;
        setEditorError(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      disposed = true;
      changes?.dispose();
      saveAction?.dispose();
      instance?.dispose();
      model?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [item.uid, item.kind, item.name, attempt]);

  useEffect(() => { editorRef.current?.updateOptions({ fontSize }); }, [fontSize, ready]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draftRef.current);
      toast.success('YAML copied to clipboard');
    } catch {
      toast.error('Clipboard unavailable');
    }
  };

  const download = () => {
    const blob = new Blob([draftRef.current], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.name}.yaml`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="yaml-editor">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/40">
        <span className={cx('text-[length:calc(10px*var(--ui-factor))] font-mono px-1.5 py-0.5 rounded-full border', dirty ? 'text-[var(--status-warn)] border-[var(--status-warn)]/40' : 'text-[var(--text-muted)] border-[var(--border-default)]')}>
          {!k8s.demo ? 'read only · live apply pending' : dirty ? 'unsaved demo changes' : 'demo manifest'}
        </span>
        <div className="flex-1" />
        <Tooltip label="Copy full document" delay={400}><IconButton icon={Copy} size="sm" onClick={copy} aria-label="Copy YAML" /></Tooltip>
        <Tooltip label="Download .yaml" delay={400}><IconButton icon={Download} size="sm" onClick={download} aria-label="Download YAML" /></Tooltip>
        <Tooltip label="Revert to original manifest" delay={400}><IconButton icon={RotateCcw} size="sm" disabled={!dirty} onClick={() => replaceDraft(original)} aria-label="Revert" /></Tooltip>
        <Button variant="primary" size="sm" disabled={!dirty || !k8s.demo} onClick={apply} className="ml-1"><Save size="calc(12px * var(--ui-factor))" />Apply</Button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className={cx('absolute inset-0', editorError && 'hidden')} />
        {editorError ? <div className="absolute inset-0 flex flex-col min-h-0">
          <div role="alert" className="p-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] border-b border-[var(--border-default)]">
            The advanced editor could not load. Your manifest is available below.
            <button className="ml-2 text-[var(--accent)]" onClick={() => setAttempt((value) => value + 1)}>Retry editor</button>
            <details className="mt-1"><summary className="cursor-pointer">Error details</summary><pre className="whitespace-pre-wrap break-words mt-1">{editorError}</pre></details>
          </div>
          <textarea style={{ fontSize }} aria-label={`YAML source for ${item.name}`} spellCheck={false} readOnly={!k8s.demo} value={draft} onChange={(event) => replaceDraft(event.target.value)} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); apply(); }
          }} className="flex-1 min-h-0 resize-none p-3 font-mono text-xs bg-[var(--bg-canvas)] text-[var(--text-primary)] outline-none" />
        </div> : !ready && <div role="status" className="absolute inset-0 flex items-center justify-center text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">Loading editor…</div>}
      </div>
    </div>
  );
}
