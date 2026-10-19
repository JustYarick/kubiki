import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught component error in Kubiki:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center bg-[var(--bg-canvas)] text-[var(--text-primary)] p-6 select-text">
          <div className="max-w-md w-full bg-[var(--bg-surface)] border border-[var(--status-danger)]/40 rounded-lg p-5 shadow-2xl">
            <div className="flex items-center gap-3 text-[var(--status-danger)] mb-3">
              <AlertTriangle size={24} />
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                {this.props.fallbackTitle || 'Component Error'}
              </h2>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              An unexpected runtime error occurred. The application remains running.
            </p>
            <pre className="bg-[var(--bg-canvas)] p-3 rounded text-[11px] font-mono text-[var(--status-danger)] overflow-x-auto border border-[var(--border-default)] mb-4">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium cursor-pointer"
            >
              <RefreshCw size={13} />
              <span>Reload Interface</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
