import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import './App.css';
import { ErrorBoundary } from "./components/ui/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="Kubiki Application Crash">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
