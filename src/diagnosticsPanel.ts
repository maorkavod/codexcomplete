import * as vscode from "vscode";
import { DiagnosticsState } from "./types";

export class DiagnosticsPanel {
  private panel: vscode.WebviewPanel | null = null;
  private readonly updateEmitter = new vscode.EventEmitter<DiagnosticsState>();
  private latest: DiagnosticsState = {
    model: "-",
    latencyMs: 0,
    lastError: null,
    lastUpdated: "-",
    usage: {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastTotalTokens: 0,
      history: []
    }
  };
  readonly onDidUpdate = this.updateEmitter.event;

  show(context: vscode.ExtensionContext): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.render();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codexCompleteDiagnostics",
      "CodexComplete Diagnostics",
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    context.subscriptions.push(this.panel);
    this.render();
  }

  update(state: DiagnosticsState): void {
    this.latest = state;
    this.updateEmitter.fire(state);
    this.render();
  }

  getLatest(): DiagnosticsState {
    return this.latest;
  }

  private render(): void {
    if (!this.panel) {
      return;
    }

    const errorValue = this.latest.lastError ?? "None";
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodexComplete Diagnostics</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; color: #222; }
    h2 { margin-top: 0; }
    .row { margin: 10px 0; }
    .label { font-weight: 600; display: inline-block; min-width: 140px; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>CodexComplete</h2>
  <div class="row"><span class="label">Model:</span><code>${escapeHtml(this.latest.model)}</code></div>
  <div class="row"><span class="label">Latency:</span><code>${this.latest.latencyMs} ms</code></div>
  <div class="row"><span class="label">Last Error:</span><code>${escapeHtml(errorValue)}</code></div>
  <div class="row"><span class="label">Updated:</span><code>${escapeHtml(this.latest.lastUpdated)}</code></div>
  <div class="row"><span class="label">Requests:</span><code>${this.latest.usage.totalRequests}</code></div>
  <div class="row"><span class="label">Total Tokens:</span><code>${this.latest.usage.totalTokens}</code></div>
  <div class="row"><span class="label">Last Request Tokens:</span><code>${this.latest.usage.lastTotalTokens}</code></div>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
