import * as vscode from "vscode";
import { API_KEY_SECRET, EXTENSION_NAMESPACE, getConfig } from "./config";
import { CompletionEngine } from "./completionEngine";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { ExtensionConfig, IndentMode } from "./types";
import { requestJson } from "./httpClient";
import { Logger } from "./logger";

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
    private readonly engine: CompletionEngine,
    private readonly logger: Logger
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.logger.info("Sidebar view resolved.");
    this.view = view;
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    this.view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSidebarMessage(message)) {
        this.logger.warn("Sidebar received unknown message payload.");
        return;
      }

      this.logger.debug(`Sidebar message received: type=${message.type}`);
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
      this.logger.info("Sidebar view disposed.");
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
        this.logger.info("Settings updated from sidebar.");
        vscode.window.showInformationMessage("CodexComplete: settings updated.");
        await this.postState();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("codexComplete.setApiKey");
        this.logger.info("Sidebar requested API key update.");
        this.modelCache = null;
        await this.postState();
        break;
      case "clearApiKey":
        await this.context.secrets.delete(API_KEY_SECRET);
        this.logger.info("API key removed from secret storage.");
        this.modelCache = null;
        vscode.window.showInformationMessage("CodexComplete: API key removed.");
        await this.postState();
        break;
      case "runCompleteNow":
        await vscode.commands.executeCommand("codexComplete.completeNow");
        this.logger.info("Sidebar triggered manual completion.");
        await this.postState();
        break;
      case "openDiagnostics":
        await vscode.commands.executeCommand("codexComplete.openPanel");
        this.logger.info("Sidebar opened diagnostics panel.");
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
    await cfg.update(
      "includeLeadingLogicComment",
      normalized.includeLeadingLogicComment,
      vscode.ConfigurationTarget.Global
    );
    await cfg.update("indentMode", normalized.indentMode, vscode.ConfigurationTarget.Global);
    await cfg.update("inlineMaxLines", normalized.inlineMaxLines, vscode.ConfigurationTarget.Global);
    await cfg.update("inlineMaxChars", normalized.inlineMaxChars, vscode.ConfigurationTarget.Global);
    await cfg.update("strictInlineMode", normalized.strictInlineMode, vscode.ConfigurationTarget.Global);
    await cfg.update("dailyTokenLimit", normalized.dailyTokenLimit, vscode.ConfigurationTarget.Global);
    await cfg.update("ignorePathRegexes", normalized.ignorePathRegexes, vscode.ConfigurationTarget.Global);
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

  private async getModelOptions(apiKey: string | undefined, selectedModel: string): Promise<string[]> {
    if (!apiKey) {
      this.logger.debug("Skipping model list fetch: API key not set.");
      return withSelectedModel(FALLBACK_MODELS, selectedModel);
    }

    const now = Date.now();
    if (
      this.modelCache &&
      this.modelCache.apiKey === apiKey &&
      now - this.modelCache.fetchedAt < MODEL_CACHE_TTL_MS
    ) {
      this.logger.debug("Using cached model list.");
      return withSelectedModel(this.modelCache.modelOptions, selectedModel);
    }

    try {
      this.logger.debug("Fetching model list from OpenAI /models.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await requestJson<OpenAIModelsResponse>("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(`OpenAI /models returned non-2xx status=${response.status}. Using fallback models.`);
        return withSelectedModel(FALLBACK_MODELS, selectedModel);
      }

      const body = response.data ?? {};
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
      this.logger.info(`Model list fetched successfully: count=${deduped.length}`);

      return withSelectedModel(deduped, selectedModel);
    } catch {
      this.logger.warn("Model list fetch failed; using fallback models.");
      return withSelectedModel(FALLBACK_MODELS, selectedModel);
    }
  }

  private renderShell(): void {
    if (!this.view) {
      return;
    }

    const scriptUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.js")
    );
    const styleUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.css")
    );

    const csp = `default-src 'none'; style-src ${this.view.webview.cspSource}; script-src ${this.view.webview.cspSource};`;

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodexComplete</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
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
    maxContextChars: clamp(config.maxContextChars, 500, 20000, 9000),
    enableInline: Boolean(config.enableInline),
    includeLeadingLogicComment: Boolean(config.includeLeadingLogicComment),
    indentMode: sanitizeIndentMode(config.indentMode),
    inlineMaxLines: clamp(config.inlineMaxLines ?? 8, 1, 64, 8),
    inlineMaxChars: clamp(config.inlineMaxChars ?? 700, 32, 4000, 700),
    strictInlineMode: config.strictInlineMode === true,
    dailyTokenLimit: clampNullable(config.dailyTokenLimit, 1, 5_000_000),
    ignorePathRegexes: sanitizeRegexArray(config.ignorePathRegexes)
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

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function sanitizeRegexArray(value: unknown): string[] {
  return sanitizeStringArray(value).filter((pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  });
}

function sanitizeIndentMode(value: unknown): IndentMode {
  if (value === "editor" || value === "language" || value === "smart") {
    return value;
  }
  return "smart";
}

function isSidebarMessage(value: unknown): value is SidebarMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }

  const message = value as { type?: unknown; payload?: unknown };
  if (typeof message.type !== "string") {
    return false;
  }

  if (message.type === "saveSettings") {
    return Boolean(message.payload && typeof message.payload === "object");
  }

  return (
    message.type === "ready" ||
    message.type === "setApiKey" ||
    message.type === "clearApiKey" ||
    message.type === "runCompleteNow" ||
    message.type === "openDiagnostics" ||
    message.type === "refresh"
  );
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
