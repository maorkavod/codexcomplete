import * as vscode from "vscode";
import { API_KEY_SECRET, EXTENSION_NAMESPACE, getConfig } from "./config";
import { CompletionEngine } from "./completionEngine";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { ExtensionConfig } from "./types";

const DEFAULT_MODEL = "gpt-5.3-codex";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_MODELS = ["gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4", "o4-mini", "gpt-4.1"];

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

type SidebarMessage =
  | { type: "ready" }
  | { type: "saveSettings"; payload: ExtensionConfig }
  | { type: "setApiKey" }
  | { type: "clearApiKey" }
  | { type: "runCompleteNow" }
  | { type: "openDiagnostics" }
  | { type: "refresh" };

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private modelCache: { apiKey: string; modelOptions: string[]; fetchedAt: number } | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: DiagnosticsPanel,
    private readonly engine: CompletionEngine
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    this.view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSidebarMessage(message)) {
        return;
      }

      await this.onMessage(message);
    });

    const diagnosticsSub = this.diagnostics.onDidUpdate(async () => {
      await this.postState();
    });

    const configSub = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(EXTENSION_NAMESPACE)) {
        await this.postState();
      }
    });

    this.view.onDidDispose(() => {
      diagnosticsSub.dispose();
      configSub.dispose();
      this.view = null;
    });

    this.renderShell();
    void this.postState();
  }

  private async onMessage(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.postState();
        break;
      case "saveSettings":
        await this.saveSettings(message.payload);
        vscode.window.showInformationMessage("CodexComplete: settings updated.");
        await this.postState();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("codexComplete.setApiKey");
        this.modelCache = null;
        await this.postState();
        break;
      case "clearApiKey":
        await this.context.secrets.delete(API_KEY_SECRET);
        this.modelCache = null;
        vscode.window.showInformationMessage("CodexComplete: API key removed.");
        await this.postState();
        break;
      case "runCompleteNow":
        await vscode.commands.executeCommand("codexComplete.completeNow");
        await this.postState();
        break;
      case "openDiagnostics":
        await vscode.commands.executeCommand("codexComplete.openPanel");
        break;
      default:
        break;
    }
  }

  private async saveSettings(payload: ExtensionConfig): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const normalized = normalizeConfig(payload);

    await cfg.update("model", normalized.model, vscode.ConfigurationTarget.Global);
    await cfg.update("requestTimeoutMs", normalized.requestTimeoutMs, vscode.ConfigurationTarget.Global);
    await cfg.update("debounceMs", normalized.debounceMs, vscode.ConfigurationTarget.Global);
    await cfg.update("maxContextChars", normalized.maxContextChars, vscode.ConfigurationTarget.Global);
    await cfg.update("enableInline", normalized.enableInline, vscode.ConfigurationTarget.Global);
    await cfg.update("dailyTokenLimit", normalized.dailyTokenLimit, vscode.ConfigurationTarget.Global);
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    const settings = getConfig();

    await this.view.webview.postMessage({
      type: "state",
      payload: {
        hasApiKey: Boolean(apiKey),
        settings,
        diagnostics: this.diagnostics.getLatest(),
        usage: this.engine.getUsageStats(),
        modelOptions: await this.getModelOptions(apiKey, settings.model)
      }
    });
  }

  private async getModelOptions(
    apiKey: string | undefined,
    selectedModel: string
  ): Promise<string[]> {
    if (!apiKey) {
      return withSelectedModel(FALLBACK_MODELS, selectedModel);
    }

    const now = Date.now();
    if (
      this.modelCache &&
      this.modelCache.apiKey === apiKey &&
      now - this.modelCache.fetchedAt < MODEL_CACHE_TTL_MS
    ) {
      return withSelectedModel(this.modelCache.modelOptions, selectedModel);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return withSelectedModel(FALLBACK_MODELS, selectedModel);
      }

      const body = (await response.json()) as OpenAIModelsResponse;
      const dynamicModels = (body.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .sort((a, b) => a.localeCompare(b));

      const deduped = dedupe(dynamicModels);
      this.modelCache = {
        apiKey,
        modelOptions: deduped,
        fetchedAt: now
      };

      return withSelectedModel(deduped, selectedModel);
    } catch {
      return withSelectedModel(FALLBACK_MODELS, selectedModel);
    }
  }

  private renderShell(): void {
    if (!this.view) {
      return;
    }

    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${this.view.webview.cspSource}; script-src 'nonce-${nonce}';`;

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodexComplete</title>
  <style>
    :root {
      --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --surface-elevated: color-mix(in srgb, var(--surface) 86%, var(--vscode-editorWidget-background, #000) 14%);
      --surface-soft: color-mix(in srgb, var(--surface) 92%, var(--vscode-input-background, #000) 8%);
      --text: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-focusBorder, #4daafc);
      --action-bg: var(--vscode-button-background, color-mix(in srgb, var(--accent) 75%, #000 25%));
      --action-fg: var(--vscode-button-foreground, #fff);
      --action-hover: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--action-bg) 90%, #fff 10%));
      --border: var(--vscode-sideBar-border, var(--vscode-editorWidget-border, #3f3f46));
      --input-bg: var(--vscode-input-background, var(--surface-soft));
      --input-fg: var(--vscode-input-foreground, var(--text));
      --input-border: var(--vscode-input-border, var(--border));
      --focus: var(--vscode-focusBorder, #4daafc);
      --ok: var(--vscode-testing-iconPassed, #3fb950);
      --warn: var(--vscode-testing-iconQueued, #d29922);
      --danger: var(--vscode-testing-iconFailed, #f85149);
      --chart-primary: var(--vscode-charts-blue, #4daafc);
      --chart-secondary: var(--vscode-charts-cyan, #33b6c5);
      --chart-axis: color-mix(in srgb, var(--muted) 65%, transparent);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 14px 12px 16px;
      color: var(--text);
      background:
        radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 60%),
        radial-gradient(90% 80% at 0% 20%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 62%),
        var(--surface);
      font-family: 'Segoe UI Variable', 'Segoe UI', ui-sans-serif, system-ui;
      line-height: 1.4;
    }

    .brand {
      letter-spacing: 0.08em;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .title {
      margin: 0;
      font-size: clamp(24px, 6vw, 36px);
      line-height: 1.08;
      letter-spacing: -0.03em;
      font-weight: 800;
    }
    .subtitle {
      margin: 8px 0 16px;
      color: var(--muted);
      font-size: 13px;
    }

    .card {
      border: 1px solid var(--border);
      background: linear-gradient(165deg, color-mix(in srgb, var(--surface-elevated) 94%, var(--accent) 6%), var(--surface-elevated));
      border-radius: 14px;
      padding: 12px;
      margin-bottom: 10px;
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, white 8%, transparent),
        0 2px 6px color-mix(in srgb, black 20%, transparent);
    }

    .card h4 {
      margin: 0 0 10px;
      font-size: 12px;
      letter-spacing: 0.45px;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }

    .status {
      margin: 0 0 10px;
      font-size: 12px;
      color: var(--muted);
      border-radius: 8px;
      padding: 8px 9px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.error { color: var(--danger); }

    .button-row {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .btn {
      height: 34px;
      width: 100%;
      border-radius: 9px;
      border: 1px solid color-mix(in srgb, var(--action-bg) 55%, var(--border));
      background: linear-gradient(160deg, color-mix(in srgb, var(--action-bg) 90%, #fff 10%), var(--action-bg));
      color: var(--action-fg);
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: transform 120ms ease, filter 120ms ease;
    }
    .btn:hover { transform: translateY(-1px); filter: brightness(1.05); }
    .btn:active { transform: translateY(0); filter: brightness(0.98); }
    .btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 1px var(--focus);
    }
    .btn.secondary {
      border-color: var(--border);
      background: var(--surface-soft);
      color: var(--text);
    }

    .settings-grid {
      display: grid;
      gap: 9px 8px;
      grid-template-columns: 1fr 1fr;
      margin-bottom: 10px;
    }
    .field {
      min-width: 0;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    .field label {
      display: block;
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.02em;
    }
    .field input, .field select {
      width: 100%;
      height: 34px;
      border-radius: 9px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--input-fg);
      font-size: 13px;
      padding: 0 10px;
      outline: none;
      min-width: 0;
    }
    .field input:focus, .field select:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 1px var(--focus);
    }

    .field-hint {
      margin-top: 5px;
      font-size: 11px;
      color: var(--muted);
    }

    .toggle {
      border: 1px solid var(--border);
      background: var(--surface-soft);
      border-radius: 9px;
      padding: 8px 9px;
      margin-bottom: 10px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toggle input[type='checkbox'] {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      margin: 0;
    }

    .grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px;
      background: var(--surface-soft);
      min-height: 58px;
    }

    .metric-label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .metric-value { display: block; font-size: 14px; font-weight: 700; word-break: break-word; }

    .chart-toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .chart-tab {
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface-soft);
      color: var(--text);
      padding: 5px 11px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.25px;
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
    }
    .chart-tab:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
    }
    .chart-tab.active {
      border-color: color-mix(in srgb, var(--accent) 78%, var(--border));
      background: color-mix(in srgb, var(--accent) 24%, var(--surface-soft));
    }
    .chart-tab:focus-visible {
      outline: none;
      box-shadow: 0 0 0 1px var(--focus);
    }
    .chart-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    canvas {
      width: 100%;
      height: 120px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, color-mix(in srgb, var(--surface-soft) 88%, var(--accent) 12%), var(--surface-soft));
    }

    @media (max-width: 460px) {
      body { padding: 10px; }
      .title { font-size: 30px; }
      .card { padding: 10px; }
      .grid { grid-template-columns: 1fr; }
      .settings-grid { grid-template-columns: 1fr; }
      .button-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="brand">CodexComplete</div>
  <h1 class="title">CodexComplete</h1>
  <p class="subtitle">Production Control Console</p>

  <section class="card">
    <h4>API Access</h4>
    <div id="apiKeyStatus" class="status"></div>
    <div class="button-row">
      <button id="setKeyBtn" class="btn">Set / Update API Key</button>
      <button id="clearKeyBtn" class="btn secondary">Clear API Key</button>
    </div>
  </section>

  <section class="card">
    <h4>Settings</h4>
    <div class="settings-grid">
      <div class="field full">
        <label for="model">Model</label>
        <select id="model"></select>
      </div>
      <div class="field">
        <label for="requestTimeoutMs">Request Timeout (ms)</label>
        <input id="requestTimeoutMs" type="number" min="1000" max="120000" />
      </div>
      <div class="field">
        <label for="debounceMs">Debounce (ms)</label>
        <input id="debounceMs" type="number" min="0" max="2000" />
      </div>
      <div class="field">
        <label for="maxContextChars">Max Context Chars</label>
        <input id="maxContextChars" type="number" min="500" max="20000" />
      </div>
      <div class="field">
        <label for="dailyTokenLimit">Daily Token Limit</label>
        <input id="dailyTokenLimit" type="number" min="1" max="5000000" placeholder="No limit" />
        <div class="field-hint">Leave empty for no daily limit.</div>
      </div>
    </div>

    <label class="toggle" for="enableInline">
      <input id="enableInline" type="checkbox" />
      <span>Enable Inline Autocomplete</span>
    </label>

    <div class="button-row">
      <button id="saveSettingsBtn" class="btn">Save Settings</button>
      <button id="completeNowBtn" class="btn secondary">Complete Now</button>
    </div>
  </section>

  <section class="card">
    <h4>Diagnostics</h4>
    <div class="grid">
      <div class="metric"><span class="metric-label">Model</span><span id="modelValue" class="metric-value">-</span></div>
      <div class="metric"><span class="metric-label">Latency</span><span id="latencyValue" class="metric-value">0 ms</span></div>
      <div class="metric"><span class="metric-label">Requests</span><span id="requestsValue" class="metric-value">0</span></div>
      <div class="metric"><span id="tokensLabel" class="metric-label">Day Tokens</span><span id="tokensValue" class="metric-value">0</span></div>
    </div>
    <div id="errorValue" class="status">Error: None</div>
    <div class="button-row">
      <button id="openDiagBtn" class="btn secondary">Open Full Diagnostics</button>
      <button id="refreshBtn" class="btn secondary">Refresh</button>
    </div>
  </section>

  <section class="card">
    <h4>Token Usage</h4>
    <div class="chart-toolbar">
      <button id="periodDayBtn" class="chart-tab active">Day</button>
      <button id="periodWeekBtn" class="chart-tab">Week</button>
      <button id="periodMonthBtn" class="chart-tab">Month</button>
    </div>
    <canvas id="tokenChart" width="620" height="180"></canvas>
    <div class="chart-meta">
      <span id="chartCaption">Daily token usage</span>
      <span id="chartTotal">Period total: 0</span>
    </div>
    <div class="grid" style="margin-top: 10px;">
      <div class="metric"><span class="metric-label">Last Input</span><span id="lastInputValue" class="metric-value">0</span></div>
      <div class="metric"><span class="metric-label">Last Output</span><span id="lastOutputValue" class="metric-value">0</span></div>
      <div class="metric"><span class="metric-label">Last Total</span><span id="lastTotalValue" class="metric-value">0</span></div>
      <div class="metric"><span class="metric-label">Updated</span><span id="updatedValue" class="metric-value" style="font-size: 12px;">-</span></div>
    </div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const modelEl = document.getElementById('model');
    const requestTimeoutMsEl = document.getElementById('requestTimeoutMs');
    const debounceMsEl = document.getElementById('debounceMs');
    const maxContextCharsEl = document.getElementById('maxContextChars');
    const dailyTokenLimitEl = document.getElementById('dailyTokenLimit');
    const enableInlineEl = document.getElementById('enableInline');

    const apiKeyStatusEl = document.getElementById('apiKeyStatus');
    const modelValueEl = document.getElementById('modelValue');
    const latencyValueEl = document.getElementById('latencyValue');
    const requestsValueEl = document.getElementById('requestsValue');
    const tokensLabelEl = document.getElementById('tokensLabel');
    const tokensValueEl = document.getElementById('tokensValue');
    const errorValueEl = document.getElementById('errorValue');
    const lastInputValueEl = document.getElementById('lastInputValue');
    const lastOutputValueEl = document.getElementById('lastOutputValue');
    const lastTotalValueEl = document.getElementById('lastTotalValue');
    const updatedValueEl = document.getElementById('updatedValue');
    const chartCaptionEl = document.getElementById('chartCaption');
    const chartTotalEl = document.getElementById('chartTotal');

    const chart = document.getElementById('tokenChart');
    const ctx = chart.getContext('2d');
    const theme = getComputedStyle(document.documentElement);
    const periodButtons = {
      day: document.getElementById('periodDayBtn'),
      week: document.getElementById('periodWeekBtn'),
      month: document.getElementById('periodMonthBtn')
    };
    let selectedPeriod = 'day';
    let latestHistory = [];

    document.getElementById('setKeyBtn').addEventListener('click', () => post({ type: 'setApiKey' }));
    document.getElementById('clearKeyBtn').addEventListener('click', () => post({ type: 'clearApiKey' }));
    document.getElementById('completeNowBtn').addEventListener('click', () => post({ type: 'runCompleteNow' }));
    document.getElementById('openDiagBtn').addEventListener('click', () => post({ type: 'openDiagnostics' }));
    document.getElementById('refreshBtn').addEventListener('click', () => post({ type: 'refresh' }));
    periodButtons.day.addEventListener('click', () => {
      selectedPeriod = 'day';
      updatePeriodButtons();
      drawChart(latestHistory, selectedPeriod);
    });
    periodButtons.week.addEventListener('click', () => {
      selectedPeriod = 'week';
      updatePeriodButtons();
      drawChart(latestHistory, selectedPeriod);
    });
    periodButtons.month.addEventListener('click', () => {
      selectedPeriod = 'month';
      updatePeriodButtons();
      drawChart(latestHistory, selectedPeriod);
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      const dailyTokenLimitRaw = String(dailyTokenLimitEl.value ?? '').trim();
      post({
        type: 'saveSettings',
        payload: {
          model: modelEl.value,
          requestTimeoutMs: Number(requestTimeoutMsEl.value),
          debounceMs: Number(debounceMsEl.value),
          maxContextChars: Number(maxContextCharsEl.value),
          enableInline: Boolean(enableInlineEl.checked),
          dailyTokenLimit: dailyTokenLimitRaw.length > 0 ? Number(dailyTokenLimitRaw) : null
        }
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'state') {
        return;
      }

      const { hasApiKey, settings, diagnostics, usage, modelOptions } = message.payload;
      renderModelOptions(modelOptions, settings.model);

      requestTimeoutMsEl.value = String(settings.requestTimeoutMs);
      debounceMsEl.value = String(settings.debounceMs);
      maxContextCharsEl.value = String(settings.maxContextChars);
      dailyTokenLimitEl.value = settings.dailyTokenLimit === null ? '' : String(settings.dailyTokenLimit);
      enableInlineEl.checked = Boolean(settings.enableInline);

      apiKeyStatusEl.textContent = hasApiKey ? 'API key configured' : 'API key not configured';
      apiKeyStatusEl.className = hasApiKey ? 'status ok' : 'status warn';

      modelValueEl.textContent = diagnostics.model;
      latencyValueEl.textContent = diagnostics.latencyMs + ' ms';
      requestsValueEl.textContent = String(usage.totalRequests);
      errorValueEl.textContent = 'Error: ' + (diagnostics.lastError || 'None');
      errorValueEl.className = diagnostics.lastError ? 'status error' : 'status ok';

      lastInputValueEl.textContent = String(usage.lastInputTokens);
      lastOutputValueEl.textContent = String(usage.lastOutputTokens);
      lastTotalValueEl.textContent = String(usage.lastTotalTokens);
      updatedValueEl.textContent = diagnostics.lastUpdated;

      latestHistory = Array.isArray(usage.history) ? usage.history : [];
      drawChart(latestHistory, selectedPeriod);
    });

    function drawChart(history, period) {
      ctx.clearRect(0, 0, chart.width, chart.height);

      const buckets = buildBuckets(history, period);
      const values = buckets.map((bucket) => bucket.total);
      const max = Math.max(1, ...values);
      const barWidth = Math.max(8, Math.floor((chart.width - 40) / values.length) - 4);
      const xStart = 20;
      const chartHeight = chart.height - 30;

      const axisColor = theme.getPropertyValue('--chart-axis').trim() || 'rgba(148, 163, 184, 0.4)';
      const chartPrimary = theme.getPropertyValue('--chart-primary').trim() || '#4daafc';
      const chartSecondary = theme.getPropertyValue('--chart-secondary').trim() || '#33b6c5';
      const muted = theme.getPropertyValue('--muted').trim() || 'rgba(148, 163, 184, 0.85)';

      ctx.strokeStyle = axisColor;
      ctx.beginPath();
      ctx.moveTo(16, chartHeight);
      ctx.lineTo(chart.width - 12, chartHeight);
      ctx.stroke();

      values.forEach((value, index) => {
        const h = Math.round((value / max) * (chartHeight - 20));
        const x = xStart + index * (barWidth + 4);
        const y = chartHeight - h;

        const grad = ctx.createLinearGradient(0, y, 0, chartHeight);
        grad.addColorStop(0, chartPrimary);
        grad.addColorStop(1, chartSecondary);

        ctx.fillStyle = grad;
        roundRect(ctx, x, y, barWidth, Math.max(3, h), 4);
        ctx.fill();
      });

      ctx.fillStyle = muted;
      ctx.font = '11px Segoe UI Variable, Segoe UI, sans-serif';
      ctx.fillText('0', 4, chartHeight + 2);
      ctx.fillText(String(max), 4, 14);

      const totalForPeriod = values.reduce((sum, value) => sum + value, 0);
      const tokensByLabel = {
        day: 'Day Tokens',
        week: 'Week Tokens',
        month: 'Month Tokens'
      };
      const captionByPeriod = {
        day: 'Daily token usage',
        week: 'Weekly token usage',
        month: 'Monthly token usage'
      };

      tokensLabelEl.textContent = tokensByLabel[period];
      tokensValueEl.textContent = String(totalForPeriod);
      chartCaptionEl.textContent = captionByPeriod[period];
      chartTotalEl.textContent = 'Period total: ' + totalForPeriod;
    }

    function updatePeriodButtons() {
      periodButtons.day.classList.toggle('active', selectedPeriod === 'day');
      periodButtons.week.classList.toggle('active', selectedPeriod === 'week');
      periodButtons.month.classList.toggle('active', selectedPeriod === 'month');
    }

    function buildBuckets(history, period) {
      const points = Array.isArray(history) ? history : [];
      const bucketCount = period === 'day' ? 14 : 12;
      const map = new Map();

      points.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
        if (!Number.isFinite(ts)) {
          return;
        }

        const date = new Date(ts);
        const key = period === 'month'
          ? monthKey(date)
          : period === 'week'
            ? weekKey(date)
            : dayKey(date);
        const current = map.get(key) || 0;
        const tokens = Number.isFinite(Number(entry.totalTokens)) ? Math.max(0, Math.floor(Number(entry.totalTokens))) : 0;
        map.set(key, current + tokens);
      });

      const labels = buildRangeKeys(period, bucketCount);
      return labels.map((label) => ({
        label,
        total: map.get(label) || 0
      }));
    }

    function buildRangeKeys(period, count) {
      const keys = [];
      const cursor = new Date();
      cursor.setHours(0, 0, 0, 0);

      for (let i = count - 1; i >= 0; i -= 1) {
        const date = new Date(cursor);
        if (period === 'month') {
          date.setMonth(date.getMonth() - i, 1);
          keys.push(monthKey(date));
          continue;
        }
        if (period === 'week') {
          date.setDate(date.getDate() - i * 7);
          keys.push(weekKey(date));
          continue;
        }
        date.setDate(date.getDate() - i);
        keys.push(dayKey(date));
      }

      return keys;
    }

    function dayKey(date) {
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      ].join('-');
    }

    function monthKey(date) {
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0')
      ].join('-');
    }

    function weekKey(date) {
      const start = new Date(date);
      const day = start.getDay();
      const distanceToMonday = (day + 6) % 7;
      start.setDate(start.getDate() - distanceToMonday);
      return dayKey(start);
    }

    function roundRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }

    function renderModelOptions(options, selected) {
      const list = Array.isArray(options) ? options : [];
      const sorted = [...new Set(list)].sort((a, b) => String(a).localeCompare(String(b)));
      if (selected && !sorted.includes(selected)) {
        sorted.unshift(selected);
      }

      modelEl.innerHTML = '';
      sorted.forEach((option) => {
        const el = document.createElement('option');
        el.value = option;
        el.textContent = option;
        if (option === selected) {
          el.selected = true;
        }
        modelEl.appendChild(el);
      });
    }

    function post(message) {
      vscode.postMessage(message);
    }

    updatePeriodButtons();
    post({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function normalizeConfig(config: ExtensionConfig): ExtensionConfig {
  const model = typeof config.model === "string" && config.model.trim().length > 0
    ? config.model.trim()
    : DEFAULT_MODEL;

  return {
    model,
    requestTimeoutMs: clamp(config.requestTimeoutMs, 1000, 120000, 15000),
    debounceMs: clamp(config.debounceMs, 0, 2000, 120),
    maxContextChars: clamp(config.maxContextChars, 500, 20000, 6000),
    enableInline: Boolean(config.enableInline),
    dailyTokenLimit: clampNullable(config.dailyTokenLimit, 1, 5_000_000)
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNullable(value: number | null | undefined, min: number, max: number): number | null {
  if (value === null || value === undefined || value === 0) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getNonce(): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 24; i += 1) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

function isSidebarMessage(value: unknown): value is SidebarMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }

  const message = value as { type?: unknown };
  return typeof message.type === "string";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function withSelectedModel(models: string[], selectedModel: string): string[] {
  const base = dedupe(models);
  if (selectedModel && !base.includes(selectedModel)) {
    return [selectedModel, ...base];
  }
  return base;
}
