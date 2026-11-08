import { useEffect, useRef, useState, type AriaAttributes, type CSSProperties, type ReactNode } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import { AlignLeft, Copy, Maximize2, Minimize2, Replace, Search, WrapText } from 'lucide-react';
import { parseDocument } from 'yaml';
import { IconButton } from './Button';
import { useUiStore } from '../../state/ui_store';
import { toast } from '../../state/notifications_store';
import type { CodeLanguage } from '../../core/code_language';
import './code_editor.css';

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeLanguage;
  ariaLabel: string;
  id?: string;
  readOnly?: boolean;
  height?: number | string;
  fill?: boolean;
  variant?: 'field' | 'document';
  toolbarLeading?: ReactNode;
  toolbarTrailing?: ReactNode;
  copyable?: boolean;
  focusTarget?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
}

/** A local, disposable model per field. In particular, Secret values are never cached. */
export function CodeEditor({ value, onChange, language = 'plaintext', ariaLabel, id, readOnly = false, height, fill = false, variant = 'field', toolbarLeading, toolbarTrailing, copyable = true, focusTarget, ...aria }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);
  const latest = useRef({ value, onChange, readOnly, language, ariaLabel });
  latest.current = { value, onChange, readOnly, language, ariaLabel };
  const fontSize = useUiStore(state => state.editorFontSize);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
  const [lines, setLines] = useState(() => value.split('\n').length);

  useEffect(() => {
    let cancelled = false;
    let instance: editor.IStandaloneCodeEditor | undefined;
    let model: editor.ITextModel | undefined;
    const subscriptions: IDisposable[] = [];
    setReady(false); setFailed(false);
    void import('../../views/monaco_setup').then(({ monaco }) => {
      if (cancelled || !hostRef.current) return;
      const props = latest.current;
      model = monaco.editor.createModel(props.value, props.language);
      modelRef.current = model;
      instance = monaco.editor.create(hostRef.current, {
        model, theme: 'kubiki-dark', readOnly: props.readOnly, ariaLabel: props.ariaLabel,
        fontSize: useUiStore.getState().editorFontSize,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
        fontLigatures: true, minimap: { enabled: false }, lineNumbers: 'on',
        lineNumbersMinChars: 3, renderLineHighlight: 'line', scrollBeyondLastLine: false,
        wordWrap: 'on', tabSize: 2, automaticLayout: true, padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false, alwaysConsumeMouseWheel: false },
        overviewRulerLanes: 0, renderWhitespace: 'selection', folding: true,
        guides: { indentation: true }, fixedOverflowWidgets: false,
        // Tab leaves an embedded field; indentation remains available with Ctrl+].
        tabFocusMode: true,
        find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never', seedSearchStringFromSelection: 'always' },
      });
      editorRef.current = instance;
      const input = instance.getDomNode()?.querySelector('textarea');
      if (input) {
        if (id) input.id = id;
        if (aria['aria-describedby']) input.setAttribute('aria-describedby', aria['aria-describedby']);
        if (aria['aria-invalid']) input.setAttribute('aria-invalid', String(aria['aria-invalid']));
      }
      subscriptions.push(model.onDidChangeContent(() => {
        const current = model!.getValue();
        setLines(model!.getLineCount());
        if (current !== latest.current.value) latest.current.onChange?.(current);
      }));
      subscriptions.push(instance.onDidChangeCursorPosition(event => setPosition(event.position)));
      setLines(model.getLineCount()); setReady(true);
      // A label/validation focus may have targeted the wrapper while the chunk loaded.
      if (document.activeElement === hostRef.current.parentElement) instance.focus();
    }).catch(() => {
      subscriptions.forEach(subscription => subscription.dispose());
      instance?.dispose(); model?.dispose();
      if (!cancelled) { editorRef.current = null; modelRef.current = null; setFailed(true); }
    });
    return () => {
      cancelled = true;
      subscriptions.forEach(subscription => subscription.dispose());
      instance?.dispose(); model?.dispose();
      editorRef.current = null; modelRef.current = null;
    };
    // Models belong to the mounted field, not its changing value or filename.
  }, [attempt]);

  useEffect(() => {
    const model = modelRef.current;
    // Only external changes (loading, encoding, name/namespace edits) replace the model.
    // Typing and undo already changed it, so keep its selection and undo history.
    if (model && model.getValue() !== value) model.setValue(value);
    setLines(value.split('\n').length);
  }, [value]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, ariaLabel, fontSize, wordWrap: wrap ? 'on' : 'off' });
    const input = editorRef.current?.getDomNode()?.querySelector('textarea');
    if (input) {
      for (const key of ['aria-describedby', 'aria-invalid'] as const) {
        const attr = aria[key];
        if (attr !== undefined && attr !== false) input.setAttribute(key, String(attr));
        else input.removeAttribute(key);
      }
    }
  }, [readOnly, ariaLabel, fontSize, wrap, ready, aria['aria-describedby'], aria['aria-invalid']]);
  useEffect(() => {
    let cancelled = false;
    if (ready) void import('../../views/monaco_setup').then(({ monaco }) => {
      if (!cancelled && modelRef.current) monaco.editor.setModelLanguage(modelRef.current, language);
    });
    return () => { cancelled = true; };
  }, [language, ready]);

  const run = (action: string) => { const instance = editorRef.current; instance?.focus(); void instance?.getAction(action)?.run(); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(modelRef.current?.getValue() ?? value); toast.success('Copied'); }
    catch { toast.error('Clipboard unavailable'); }
  };
  const format = () => {
    const model = modelRef.current; const instance = editorRef.current;
    if (!model || !instance || readOnly) return;
    try {
      const source = model.getValue();
      let formatted: string;
      if (language === 'json') formatted = JSON.stringify(JSON.parse(source), null, 2) + '\n';
      else {
        const document = parseDocument(source);
        if (document.errors.length) throw document.errors[0];
        formatted = document.toString({ indent: 2 });
      }
      // Formatting is one undoable edit; no automatic formatting on load/save.
      instance.pushUndoStop();
      instance.executeEdits('format', [{ range: model.getFullModelRange(), text: formatted }]);
      instance.pushUndoStop(); instance.focus();
    } catch { toast.error('Cannot format invalid ' + language.toUpperCase()); }
  };
  const label = language === 'plaintext' ? 'Text' : language === 'shell' ? 'Shell' : language.toUpperCase();
  const style = { '--code-height': height === undefined ? `${Math.min(280, Math.max(140, lines * 19 + 54))}px` : typeof height === 'number' ? `${height}px` : height } as CSSProperties;
  return <div className="code-editor" role="group" aria-label={`${ariaLabel} editor`} data-language={language} data-fill={fill} data-variant={variant} data-expanded={expanded} data-secret-field={focusTarget} data-ready={ready} tabIndex={-1} style={style}
    onFocus={event => { if (event.target === event.currentTarget) { editorRef.current?.focus(); if (failed) event.currentTarget.querySelector('textarea')?.focus(); } }}>
    <div className="code-editor-toolbar" role="toolbar" aria-label={`${ariaLabel} tools`}>
      {toolbarLeading}
      <span className="code-editor-language">{label}</span>
      <span className="code-editor-stats" title={`Ln ${position.lineNumber}, Col ${position.column}`}>{lines} {lines === 1 ? 'line' : 'lines'}{readOnly && ' · read only'}</span>
      <div className="code-editor-actions">
        <IconButton type="button" size="sm" icon={Search} disabled={!ready} aria-label={`Find in ${ariaLabel}`} tooltip="Find (Ctrl+F)" onClick={() => run('actions.find')} />
        {!readOnly && <IconButton type="button" size="sm" icon={Replace} disabled={!ready} aria-label={`Replace in ${ariaLabel}`} tooltip="Replace (Ctrl+H)" onClick={() => run('editor.action.startFindReplaceAction')} />}
        {!readOnly && (language === 'yaml' || language === 'json') && <IconButton type="button" size="sm" icon={AlignLeft} disabled={!ready} aria-label={`Format ${ariaLabel}`} tooltip={`Format ${label}`} onClick={format} />}
        <IconButton type="button" size="sm" icon={WrapText} active={wrap} aria-pressed={wrap} aria-label={`Wrap lines in ${ariaLabel}`} tooltip="Wrap lines" onClick={() => setWrap(current => !current)} />
        {copyable && <IconButton type="button" size="sm" icon={Copy} aria-label={`Copy ${ariaLabel}`} tooltip="Copy all" onClick={() => void copy()} />}
        {!fill && <IconButton type="button" size="sm" icon={expanded ? Minimize2 : Maximize2} aria-pressed={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${ariaLabel}`} tooltip={expanded ? 'Collapse editor' : 'Expand editor'} onClick={() => setExpanded(current => !current)} />}
        {toolbarTrailing}
      </div>
    </div>
    <div className="code-editor-body">
      <div ref={hostRef} className="code-editor-host" hidden={failed} />
      {!ready && !failed && <span role="status" className="code-editor-loading">Loading editor…</span>}
      {failed && <div className="code-editor-fallback"><div role="status">Editor unavailable. <button type="button" onClick={() => setAttempt(current => current + 1)}>Retry</button></div><textarea id={id} aria-label={ariaLabel} {...aria} value={value} readOnly={readOnly} spellCheck={false} autoComplete="off" wrap={wrap ? 'soft' : 'off'} onChange={event => onChange?.(event.target.value)} /></div>}
    </div>
  </div>;
}
