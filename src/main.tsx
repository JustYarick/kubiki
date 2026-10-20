import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import './App.css';
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { useUiStore } from './state/ui_store';
import { applyAppearance } from './core/appearance';

// Apply persisted values before the first render, including body portals.
applyAppearance(document.documentElement, useUiStore.getState());
useUiStore.subscribe((state, previous) => {
  if (state.uiScale !== previous.uiScale || state.editorFontSize !== previous.editorFontSize || state.terminalFontSize !== previous.terminalFontSize) {
    applyAppearance(document.documentElement, state);
    if (state.uiScale !== previous.uiScale) window.dispatchEvent(new Event('resize'));
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="Kubiki Application Crash">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
