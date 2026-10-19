import React, { useEffect, useMemo, useRef, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Copy, Download, RotateCcw, Save } from 'lucide-react';
import './monaco_setup';
import { Button, IconButton, Tooltip } from '../components/ui/Button';
import { toast } from '../state/notifications_store';
import type { ResourceItem } from '../types/k8s';
import { cx } from '../core/utils/cx';

interface YamlEditorProps {
  item: ResourceItem;
  onApply: (yaml: string) => void;
}

export const YamlEditor: React.FC<YamlEditorProps> = ({ item, onApply }) => {
  const original = item.rawYaml ?? '';
  const [draft, setDraft] = useState(original);
  const [ready, setReady] = useState(false);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const dirty = draft !== original;

  // Re-sync when a different resource is selected (keep local edits per selection otherwise).
  useEffect(() => {
    setDraft(original);
  }, [item.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    if (!dirty) return;
    onApply(draft);
  };

  // Cmd/Ctrl+S is captured while the pane is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, original]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dirty ? draft : original);
      toast.success('YAML copied to clipboard');
    } catch {
      toast.error('Clipboard unavailable');
    }
  };

  const download = () => {
    const blob = new Blob([dirty ? draft : original], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.name}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded', `${item.name}.yaml`);
  };

  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontSize: 12.5,
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
    }),
    []
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/40">
        <span
          className={cx(
            'text-[10px] font-mono px-1.5 py-0.5 rounded-full border',
            dirty
              ? 'text-[var(--status-warn)] border-[var(--status-warn)]/40 bg-[var(--status-warn)]/10'
              : 'text-[var(--text-muted)] border-[var(--border-default)]'
          )}
        >
          {dirty ? 'unsaved changes' : 'in sync'}
        </span>

        <div className="flex-1" />

        <Tooltip label="Copy (full document)" delay={400}>
          <IconButton icon={Copy} size="sm" onClick={copy} aria-label="Copy YAML" />
        </Tooltip>
        <Tooltip label="Download .yaml" delay={400}>
          <IconButton icon={Download} size="sm" onClick={download} aria-label="Download YAML" />
        </Tooltip>
        <Tooltip label="Revert to cluster version" delay={400}>
          <IconButton
            icon={RotateCcw}
            size="sm"
            disabled={!dirty}
            onClick={() => setDraft(original)}
            aria-label="Revert"
          />
        </Tooltip>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={apply} className="ml-1">
          <Save size={12} />
          Apply
          <kbd className="ml-1 text-[9px] opacity-70 font-mono">⌘S</kbd>
        </Button>
      </div>

      {/* Monaco */}
      <div className="flex-1 min-h-0 relative">
        <MonacoEditor
          language="yaml"
          theme="kubiki-dark"
          value={draft}
          options={options}
          beforeMount={() => setReady(true)}
          onMount={(ed) => {
            editorRef.current = ed;
            ed.focus();
          }}
          onChange={(v) => setDraft(v ?? '')}
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--text-muted)]">
            Loading editor…
          </div>
        )}
      </div>
    </div>
  );
};
