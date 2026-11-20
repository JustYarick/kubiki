import { lazy } from 'react';
import { ScrollText } from 'lucide-react';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useClusterStore } from '../../state/cluster_store';
import { activeWorkspaceArea } from '../workspace_areas';
import { openWorkspacePanel, registerWorkspacePanel, type WorkspacePanel } from '../workspace_panels';
import { createDiagnosticTransport } from '../../providers/diagnostics';
import { diagnostics, recordDiagnostic } from './collector';
import { diagnosticErrorAttributes } from './model';
const View = lazy(() => import('../../components/diagnostics/DiagnosticLogsView').then(m => ({ default: m.DiagnosticLogsView })));
export const diagnosticPanel: WorkspacePanel = { id: 'developer-logs', title: 'Application Logs', icon: ScrollText, context: 'global', component: View };
export const nativeDiagnostics = createDiagnosticTransport();
export function initializeDiagnostics(): () => void {
  let unregister: (() => void) | undefined;
  const native = '__TAURI_INTERNALS__' in window;
  const sync = (enabled: boolean, open = false) => {
    diagnostics.setEnabled(enabled, enabled && native);
    if (native) void nativeDiagnostics.configure(enabled);
    if (enabled) {
      unregister ??= registerWorkspacePanel(diagnosticPanel);
      if (open) openWorkspacePanel(diagnosticPanel);
    } else {
      const workspace = useWorkspaceStore.getState();
      const active = activeWorkspaceArea(workspace) === diagnosticPanel.id;
      for (const tab of workspace.tabs) if (tab.panelId === diagnosticPanel.id) workspace.closeTab(tab.id);
      unregister?.(); unregister = undefined;
      if (active) useWorkspaceStore.getState().activateArea('explorer');
    }
  };
  sync(useUiStore.getState().developerMode);
  const ui = useUiStore.subscribe((state, previous) => { if (state.developerMode !== previous.developerMode) sync(state.developerMode, state.developerMode); });
  const workspace = useWorkspaceStore.subscribe((state, previous) => {
    const area = activeWorkspaceArea(state);
    if (state.activeTabId !== previous.activeTabId || area !== activeWorkspaceArea(previous)) recordDiagnostic('navigation.changed', 'DEBUG', { area });
  });
  const cluster = useClusterStore.subscribe((state, previous) => {
    if (state.currentContext !== previous.currentContext || state.selectedNamespace !== previous.selectedNamespace || state.isConnected !== previous.isConnected)
      recordDiagnostic('scope.changed', 'INFO', { context: state.currentContext, namespace: state.selectedNamespace });
  });
  const error = (event: ErrorEvent) => recordDiagnostic('runtime.error', 'ERROR', { ...diagnosticErrorAttributes(event.error), 'code.line.number': event.lineno, 'code.column.number': event.colno });
  const rejection = (event: PromiseRejectionEvent) => recordDiagnostic('runtime.rejection', 'ERROR', diagnosticErrorAttributes(event.reason));
  window.addEventListener('error', error); window.addEventListener('unhandledrejection', rejection);
  const close = () => {
    ui(); workspace(); cluster(); unregister?.(); unregister = undefined;
    window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection); window.removeEventListener('pagehide', close);
    diagnostics.setEnabled(false);
    if (native) void nativeDiagnostics.configure(false);
  };
  window.addEventListener('pagehide', close);
  return close;
}
