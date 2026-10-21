import { ResponsiveToolbar } from '../components/ui/ResponsiveToolbar';
import { MenuList, Popover, type MenuItem } from '../components/ui/Dropdown';
import './yaml.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import { Copy, Download, RotateCcw, Save, Search, ArrowRightLeft, AlignLeft, Eye, EyeOff, Loader2, MoreHorizontal } from 'lucide-react';
import { Button, IconButton, Tooltip } from '../components/ui/Button';
import { toast } from '../state/notifications_store';
import type { ResourceItem } from '../types/k8s';
import { parse, stringify } from 'yaml';
import { cx } from '../core/utils/cx';
import { useUiStore } from '../state/ui_store';
import { useClusterStore } from '../state/cluster_store';
import { useYamlDraftStore, yamlDraftKey } from '../state/yaml_draft_store';
import { cleanYaml, restoreServerFields, sameYaml } from '../core/resources/yaml_document';

interface YamlEditorProps {
  item: ResourceItem;
  onApply: (yaml: string) => Promise<void> | void;
}

export function YamlEditor({ item, onApply }: YamlEditorProps) {
  const fontSize = useUiStore((state) => state.editorFontSize);
  const context = useClusterStore((state) => state.currentContext) || '';
  const draftKey = useMemo(
    () => yamlDraftKey(context, item.kind, item.namespace, item.name, item.uid),
    [context, item.kind, item.namespace, item.name, item.uid]
  );
  const original = item.rawYaml ?? '';
  const existingMemento = useYamlDraftStore.getState().getDraft(draftKey);

  const [cleanView, setCleanView] = useState(() => (existingMemento && existingMemento.uid === item.uid ? existingMemento.cleanView : true));
  const cleanViewRef = useRef(cleanView);
  cleanViewRef.current = cleanView;

  const [draft, setDraft] = useState(() => {
    if (existingMemento && existingMemento.uid === item.uid && existingMemento.dirty) {
      return existingMemento.draft;
    }
    return cleanYaml(original);
  });
  const [ready, setReady] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [applying, setApplying] = useState(false);
  const fullDraftRef = useRef(
    existingMemento && existingMemento.uid === item.uid && existingMemento.dirty
      ? existingMemento.fullDraft
      : original
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);
  const draftRef = useRef(draft);
  const previous = useRef({ uid: item.uid, original });
  const baseline = useMemo(() => cleanView ? cleanYaml(original) : original, [cleanView, original]);
  const dirty = !sameYaml(draft, baseline);

  const replaceDraft = useCallback((value: string) => {
    draftRef.current = value;
    const model = modelRef.current;
    if (model && !model.isDisposed() && model.getValue() !== value) model.setValue(value);
    setDraft(value);
    const isDirty = !sameYaml(value, cleanViewRef.current ? cleanYaml(original) : original);
    useYamlDraftStore.getState().saveDraft(draftKey, {
      draft: value,
      fullDraft: fullDraftRef.current,
      cleanView: cleanViewRef.current,
      resourceVersion: item.raw?.metadata?.resourceVersion || '',
      uid: item.uid,
      dirty: isDirty,
    });
  }, [cleanViewRef, draftKey, item.raw?.metadata?.resourceVersion, item.uid, original]);

  // Refresh clean documents; never overwrite a local draft on a background snapshot.
  useEffect(() => {
    const prior = previous.current;
    const memento = useYamlDraftStore.getState().getDraft(draftKey);
    const hasUnsavedDraft = memento && memento.uid === item.uid && memento.dirty;

    if (!hasUnsavedDraft) {
      const pristine = sameYaml(draftRef.current, cleanViewRef.current ? cleanYaml(prior.original) : prior.original);
      if (prior.uid !== item.uid || pristine) {
        fullDraftRef.current = original;
        replaceDraft(cleanViewRef.current ? cleanYaml(original) : original);
      }
    }
    previous.current = { uid: item.uid, original };
  }, [draftKey, item.uid, original, replaceDraft]);

  const apply = useCallback(async () => {
    if (sameYaml(draftRef.current, baseline) || applying) return;
    try {
      const parsed = parse(draftRef.current);
      if (!parsed || typeof parsed !== 'object' || parsed.metadata?.name !== item.name || parsed.kind !== item.kind) {
        throw new Error('The manifest must keep the resource kind and name.');
      }
      setApplying(true);
      const manifest = stringify(parsed);
      await onApply(manifest);
      useYamlDraftStore.getState().clearDraft(draftKey);
      replaceDraft(manifest);
    } catch (error) {
      toast.error('Apply failed', String(error));
    } finally {
      setApplying(false);
    }
  }, [baseline, item.kind, item.name, onApply, replaceDraft, applying]);
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
        readOnly: false,
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
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: 'never',
          seedSearchStringFromSelection: 'always',
        },
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
        run: () => void applyRef.current(),
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

  const openFind = () => {
    editorRef.current?.trigger('toolbar', 'actions.find', null);
  };

  const openReplace = () => {
    editorRef.current?.trigger('toolbar', 'editor.action.startFindReplaceAction', null);
  };

  const formatYaml = () => {
    try {
      const parsed = parse(draftRef.current);
      if (parsed) {
        const formatted = stringify(parsed, { indent: 2 });
        replaceDraft(formatted);
        toast.info('YAML formatted');
      }
    } catch (err) {
      toast.error('Cannot format invalid YAML', String(err));
    }
  };

  const toggleCleanView = () => {
    try {
      // Validate before switching, and retain local edits in both projections.
      parse(draftRef.current);
      if (cleanView) replaceDraft(restoreServerFields(draftRef.current, fullDraftRef.current));
      else {
        fullDraftRef.current = draftRef.current;
        replaceDraft(cleanYaml(draftRef.current));
      }
      setCleanView(!cleanView);
    } catch (err) {
      toast.error('Cannot parse YAML', String(err));
    }
  };

  const revert = () => {
    useYamlDraftStore.getState().clearDraft(draftKey);
    fullDraftRef.current = original;
    replaceDraft(baseline);
  };
  const actions: MenuItem[] = [
    { id: 'replace', label: 'Find and Replace', icon: ArrowRightLeft, onSelect: openReplace },
    { id: 'format', label: 'Format YAML', icon: AlignLeft, onSelect: formatYaml },
    { id: 'server-fields', label: 'Show server fields', icon: cleanView ? Eye : EyeOff, checked: !cleanView, onSelect: toggleCleanView },
    { id: 'copy', label: 'Copy YAML', icon: Copy, onSelect: copy },
    { id: 'download', label: 'Download YAML', icon: Download, onSelect: download },
    { id: 'revert', label: 'Revert', icon: RotateCcw, disabled: !dirty || applying, onSelect: revert },
  ];
  return (
    <div className="yaml-editor h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]" data-testid="yaml-editor">
      <ResponsiveToolbar label="YAML editor toolbar" className="yaml-toolbar"
        identity={<>
          <span className="yaml-resource-name" title={`${item.kind}/${item.name}`}>{item.kind}/{item.name}</span>
          <span className="yaml-manifest-state" data-dirty={dirty} title={dirty ? 'Unsaved edits' : 'Clean manifest'}>
            <span className="yaml-manifest-state-long">{dirty ? 'Unsaved edits' : 'Clean manifest'}</span>
            <span className="yaml-manifest-state-short">{dirty ? 'Edited' : 'Clean'}</span>
          </span>
        </>}
        primaryAction={<Button variant="primary" size="sm" disabled={!dirty || applying} onClick={apply} className="yaml-apply" aria-label="Apply" aria-busy={applying} title="Apply manifest (Ctrl+S)">
          {applying ? <Loader2 size="calc(12px * var(--ui-factor))" className="animate-spin" /> : <Save size="calc(12px * var(--ui-factor))" />}
          <span className="yaml-apply-label">{applying ? 'Applying…' : 'Apply'}</span>
        </Button>}>
        <Tooltip label="Find in document (Ctrl+F)" delay={300}><IconButton icon={Search} size="sm" onClick={openFind} aria-label="Find" /></Tooltip>
        <div className="yaml-secondary-action flex items-center gap-1">
          <IconButton icon={ArrowRightLeft} size="sm" onClick={openReplace} aria-label="Replace" tooltip="Find and Replace (Ctrl+H)" />
          <IconButton icon={AlignLeft} size="sm" onClick={formatYaml} aria-label="Format YAML" tooltip="Format YAML indentation" />
          <IconButton icon={cleanView ? Eye : EyeOff} size="sm" active={!cleanView} onClick={toggleCleanView} aria-label="Show server fields" aria-pressed={!cleanView} tooltip="Show server fields (status/managedFields)" />
          <IconButton icon={Copy} size="sm" onClick={copy} aria-label="Copy YAML" tooltip="Copy full document" />
          <IconButton icon={Download} size="sm" onClick={download} aria-label="Download YAML" tooltip="Download .yaml" />
          <IconButton icon={RotateCcw} size="sm" disabled={!dirty || applying} onClick={revert} aria-label="Revert" tooltip="Revert to cluster manifest" />
        </div>
        <div className="yaml-actions-overflow"><Popover align="end" width={230} trigger={() => <IconButton icon={MoreHorizontal} size="sm" aria-label="More YAML actions" aria-haspopup="menu" tooltip="More YAML actions" />}>
          {close => <div role="menu" aria-label="YAML actions"><MenuList items={actions} autoFocus onSelect={action => { close(); action.onSelect?.(); }} /></div>}
        </Popover></div>
      </ResponsiveToolbar>

      <div className="yaml-editor-content">
        <div ref={containerRef} className={cx('absolute inset-0', editorError && 'hidden')} />
        {editorError ? (
          <div className="absolute inset-0 flex flex-col min-h-0">
            <div role="alert" className="p-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] border-b border-[var(--border-default)]">
              The advanced editor could not load. Your manifest is available below.
              <button className="ml-2 text-[var(--accent)]" onClick={() => setAttempt((value) => value + 1)}>Retry editor</button>
              <details className="mt-1"><summary className="cursor-pointer">Error details</summary><pre className="whitespace-pre-wrap break-words mt-1">{editorError}</pre></details>
            </div>
            <textarea
              style={{ fontSize }}
              aria-label={`YAML source for ${item.name}`}
              spellCheck={false}
              value={draft}
              onChange={(event) => replaceDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void apply(); }
              }}
              className="flex-1 min-h-0 min-w-0 w-full resize-none p-3 font-mono text-xs bg-[var(--bg-canvas)] text-[var(--text-primary)] outline-none"
            />
          </div>
        ) : !ready && (
          <div role="status" className="absolute inset-0 flex items-center justify-center text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] gap-2">
            <Loader2 size="calc(14px * var(--ui-factor))" className="animate-spin text-[var(--accent)]" />
            Loading editor…
          </div>
        )}
      </div>
    </div>
  );
}
