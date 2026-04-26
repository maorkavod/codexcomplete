import * as vscode from "vscode";
import { ContextCollector } from "./contextCollector";
import { OpenAIClient } from "./openaiClient";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { Logger } from "./logger";
import { formatInsertionText } from "./insertionFormatter";
import {
  CompletionMode,
  CompletionResult,
  ConfigProvider,
  DiagnosticsState,
  EditorIndentation,
  TokenUsage,
  UsagePoint,
  UsageStats
} from "./types";

const CACHE_TTL_MS = 3000;
const USAGE_HISTORY_LIMIT = 5000;

export class CompletionEngine {
  private readonly client: OpenAIClient;
  private readonly collector: ContextCollector;
  private readonly getConfig: ConfigProvider;
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly diagnosticsPanel: DiagnosticsPanel;
  private readonly saveUsageStats: (stats: UsageStats) => Promise<void>;
  private readonly logger: Logger;

  private cache = new Map<string, { value: string; ts: number }>();
  private inFlight = new Map<string, Promise<CompletionResult>>();
  private recentAcceptedByDocument = new Map<string, { text: string; ts: number }>();
  private requestNonce = 0;
  private usageStats: UsageStats;

  constructor(options: {
    client: OpenAIClient;
    collector: ContextCollector;
    getConfig: ConfigProvider;
    getApiKey: () => Promise<string | undefined>;
    diagnosticsPanel: DiagnosticsPanel;
    initialUsageStats?: UsageStats;
    saveUsageStats: (stats: UsageStats) => Promise<void>;
    logger: Logger;
  }) {
    this.client = options.client;
    this.collector = options.collector;
    this.getConfig = options.getConfig;
    this.getApiKey = options.getApiKey;
    this.diagnosticsPanel = options.diagnosticsPanel;
    this.usageStats = sanitizeUsageStats(options.initialUsageStats);
    this.saveUsageStats = options.saveUsageStats;
    this.logger = options.logger;
  }

  getUsageStats(): UsageStats {
    return {
      ...this.usageStats,
      history: this.usageStats.history.map((entry) => ({ ...entry }))
    };
  }

  async complete(params: {
    document: vscode.TextDocument;
    position: vscode.Position;
    mode: CompletionMode;
    token: vscode.CancellationToken;
    selectedText?: string;
    editorOptions?: EditorIndentation;
  }): Promise<CompletionResult> {
    const config = this.getConfig();
    const start = Date.now();
    this.logger.debug(
      `Completion requested: mode=${params.mode} language=${params.document.languageId} model=${config.model}`
    );

    if (shouldIgnoreDocument(params.document, config.ignorePathRegexes)) {
      this.logger.debug("Completion skipped: document path matched ignore rules.");
      return this.respondWithNoText(config.model, start, null);
    }

    if (params.mode === "inline" && !config.enableInline) {
      this.logger.debug("Completion skipped: inline completions are disabled in settings.");
      return this.respondWithNoText(config.model, start, null);
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.logger.warn("Completion skipped: missing API key.");
      const diagnostics = this.diag(config.model, start, "Missing API key");
      this.diagnosticsPanel.update(diagnostics);
      this.recordNullResponse(false);
      return { text: null, diagnostics };
    }

    const context = this.collector.collect(
      params.document,
      params.position,
      config.maxContextChars,
      params.selectedText,
      params.editorOptions
    );

    const cacheKey = buildCacheKey(config.model, params.mode, context.prefix, context.suffix);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      this.logger.debug("Completion served from cache.");
      this.usageStats.suggestionsShown = (this.usageStats.suggestionsShown ?? 0) + 1;
      this.persistUsageStats();
      const diagnostics = this.diag(config.model, start, null);
      this.diagnosticsPanel.update(diagnostics);
      return { text: cached.value, diagnostics };
    }

    if (params.mode === "inline") {
      await wait(config.debounceMs, params.token);
      if (params.token.isCancellationRequested) {
        this.logger.debug("Completion canceled during debounce.");
        const diagnostics = this.diag(config.model, start, "Request canceled");
        this.diagnosticsPanel.update(diagnostics);
        this.recordNullResponse(false);
        return { text: null, diagnostics };
      }
    }

    if (config.dailyTokenLimit !== null) {
      const usedToday = calculateTodayTokenUsage(this.usageStats.history, new Date());
      if (usedToday >= config.dailyTokenLimit) {
        this.logger.warn(
          `Completion blocked by daily token limit: used=${usedToday} limit=${config.dailyTokenLimit}`
        );
        const diagnostics = this.diag(
          config.model,
          start,
          `Daily token limit reached (${usedToday}/${config.dailyTokenLimit}).`
        );
        this.diagnosticsPanel.update(diagnostics);
        this.recordNullResponse(false);
        return { text: null, diagnostics };
      }
    }

    const inFlightKey = `${cacheKey}|${params.position.line}|${params.position.character}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) {
      this.logger.debug("Completion joined an in-flight identical request.");
      const joined = await existing;
      if (joined.text) {
        this.usageStats.suggestionsShown = (this.usageStats.suggestionsShown ?? 0) + 1;
        this.persistUsageStats();
      }
      return joined;
    }

    const work = this.completeInternal({
      ...params,
      apiKey,
      config,
      context,
      start,
      cacheKey
    }).finally(() => {
      this.inFlight.delete(inFlightKey);
    });

    this.inFlight.set(inFlightKey, work);
    return work;
  }

  private async completeInternal(params: {
    document: vscode.TextDocument;
    position: vscode.Position;
    mode: CompletionMode;
    token: vscode.CancellationToken;
    apiKey: string;
    config: ReturnType<ConfigProvider>;
    context: ReturnType<ContextCollector["collect"]>;
    start: number;
    cacheKey: string;
  }): Promise<CompletionResult> {
    const nonce = ++this.requestNonce;
    this.logger.info(
      `Sending completion request: mode=${params.mode} model=${params.config.model} prefixChars=${params.context.prefix.length} suffixChars=${params.context.suffix.length}`
    );
    const response = await this.client.complete(
      {
        apiKey: params.apiKey,
        model: params.config.model,
        timeoutMs: params.config.requestTimeoutMs,
        mode: params.mode,
        includeLeadingLogicComment: params.config.includeLeadingLogicComment,
        strictInlineMode: params.config.strictInlineMode,
        inlineMaxLines: params.config.inlineMaxLines,
        inlineMaxChars: params.config.inlineMaxChars,
        context: params.context
      },
      params.token
    );

    if (params.token.isCancellationRequested || nonce !== this.requestNonce) {
      this.logger.debug("Completion canceled after request start.");
      const diagnostics = this.diag(params.config.model, params.start, "Request canceled");
      this.diagnosticsPanel.update(diagnostics);
      this.recordNullResponse(false);
      return { text: null, diagnostics };
    }

    this.consumeUsage(response.usage);
    if (response.error) {
      this.logger.warn(`Completion request failed: ${response.error}`);
    } else {
      this.logger.info(
        `Completion request finished: totalTokens=${response.usage.totalTokens} latencyMs=${Date.now() - params.start}`
      );
    }

    const diagnostics = this.diag(params.config.model, params.start, response.error);
    this.diagnosticsPanel.update(diagnostics);

    let finalText = response.text;
    let indentCorrected = false;

    if (finalText) {
      const formatted = formatInsertionText(finalText, params.context, {
        mode: params.mode,
        indentMode: params.config.indentMode ?? "smart"
      });
      finalText = formatted.text;
      indentCorrected = formatted.corrected;
      if (indentCorrected) {
        this.usageStats.indentCorrections = (this.usageStats.indentCorrections ?? 0) + 1;
        this.persistUsageStats();
      }
    }

    if (finalText) {
      const documentKey = params.document.uri.toString();
      const recentAccepted = this.recentAcceptedByDocument.get(documentKey);
      if (shouldSuppressRepeatedAcceptance(finalText, params.context.prefix, recentAccepted)) {
        this.logger.debug("Completion suppressed due to repeated-acceptance protection.");
        finalText = null;
      }
    }

    if (finalText) {
      this.cache.set(params.cacheKey, { value: finalText, ts: Date.now() });
      this.recentAcceptedByDocument.set(params.document.uri.toString(), {
        text: normalizeForComparison(finalText),
        ts: Date.now()
      });
      this.usageStats.suggestionsShown = (this.usageStats.suggestionsShown ?? 0) + 1;
      this.persistUsageStats();
      this.logger.debug(`Completion text received: length=${finalText.length}`);
    } else {
      const reason = response.debugMeta?.reason ?? response.error ?? "no_text_after_pipeline";
      this.logger.debug(`Completion returned empty text. reason=${reason}`);
      this.recordNullResponse(isTimeoutError(response.error));
    }

    return {
      text: finalText,
      diagnostics,
      debugMeta: response.debugMeta
    };
  }

  private respondWithNoText(model: string, start: number, error: string | null): CompletionResult {
    const diagnostics = this.diag(model, start, error);
    this.recordNullResponse(false);
    return { text: null, diagnostics };
  }

  private recordNullResponse(timeout: boolean): void {
    this.usageStats.nullResponses = (this.usageStats.nullResponses ?? 0) + 1;
    if (timeout) {
      this.usageStats.timeoutResponses = (this.usageStats.timeoutResponses ?? 0) + 1;
    }
    this.persistUsageStats();
  }

  private consumeUsage(usage: TokenUsage): void {
    this.usageStats.totalRequests += 1;
    this.usageStats.totalInputTokens += usage.inputTokens;
    this.usageStats.totalOutputTokens += usage.outputTokens;
    this.usageStats.totalTokens += usage.totalTokens;
    this.usageStats.lastInputTokens = usage.inputTokens;
    this.usageStats.lastOutputTokens = usage.outputTokens;
    this.usageStats.lastTotalTokens = usage.totalTokens;
    this.usageStats.history = [
      ...this.usageStats.history,
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        timestamp: new Date().toISOString()
      }
    ].slice(-USAGE_HISTORY_LIMIT);

    void this.saveUsageStats(this.getUsageStats());
  }

  private persistUsageStats(): void {
    void this.saveUsageStats(this.getUsageStats());
  }

  private diag(model: string, start: number, lastError: string | null): DiagnosticsState {
    return {
      model,
      latencyMs: Date.now() - start,
      lastError,
      lastUpdated: new Date().toISOString(),
      usage: this.getUsageStats()
    };
  }
}

function shouldSuppressRepeatedAcceptance(
  text: string,
  prefix: string,
  recent: { text: string; ts: number } | undefined
): boolean {
  if (!recent) {
    return false;
  }

  const now = Date.now();
  if (now - recent.ts > 15000) {
    return false;
  }

  const normalized = normalizeForComparison(text);
  if (!normalized || normalized !== recent.text) {
    return false;
  }

  const prefixTail = normalizeForComparison(prefix.slice(-800));
  return prefixTail.includes(normalized);
}

function normalizeForComparison(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

async function wait(ms: number, token: vscode.CancellationToken): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);

    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      reject(new Error("Canceled"));
    });
  }).catch(() => undefined);
}

function buildCacheKey(model: string, mode: CompletionMode, prefix: string, suffix: string): string {
  const prefixTail = prefix.slice(-240);
  const suffixHead = suffix.slice(0, 100);
  return `${model}|${mode}|${prefixTail}|${suffixHead}`;
}

function shouldIgnoreDocument(document: vscode.TextDocument, regexPatterns: string[]): boolean {
  const filePath = document.fileName || document.uri.fsPath || document.uri.path;
  const normalizedPath = filePath.replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.includes("env")) {
    return true;
  }

  for (const pattern of regexPatterns) {
    try {
      if (new RegExp(pattern).test(normalizedPath)) {
        return true;
      }
    } catch {
      // Invalid regexes are ignored to avoid breaking completions.
    }
  }

  return false;
}

function sanitizeUsageStats(raw?: UsageStats): UsageStats {
  const parsedHistory = sanitizeHistory(raw?.history);

  if (!raw) {
    return {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastTotalTokens: 0,
      suggestionsShown: 0,
      nullResponses: 0,
      timeoutResponses: 0,
      indentCorrections: 0,
      history: parsedHistory
    };
  }

  const totalRequests = Math.max(0, Math.floor(raw.totalRequests ?? parsedHistory.length));
  const totalInputTokens = Math.max(0, Math.floor(raw.totalInputTokens ?? 0));
  const totalOutputTokens = Math.max(0, Math.floor(raw.totalOutputTokens ?? 0));
  const totalTokens = Math.max(
    0,
    Math.floor(raw.totalTokens ?? totalInputTokens + totalOutputTokens)
  );
  const lastPoint = parsedHistory[parsedHistory.length - 1];

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    lastInputTokens: Math.max(0, Math.floor(raw.lastInputTokens ?? lastPoint?.inputTokens ?? 0)),
    lastOutputTokens: Math.max(0, Math.floor(raw.lastOutputTokens ?? lastPoint?.outputTokens ?? 0)),
    lastTotalTokens: Math.max(0, Math.floor(raw.lastTotalTokens ?? lastPoint?.totalTokens ?? 0)),
    suggestionsShown: Math.max(0, Math.floor(raw.suggestionsShown ?? 0)),
    nullResponses: Math.max(0, Math.floor(raw.nullResponses ?? 0)),
    timeoutResponses: Math.max(0, Math.floor(raw.timeoutResponses ?? 0)),
    indentCorrections: Math.max(0, Math.floor(raw.indentCorrections ?? 0)),
    history: parsedHistory
  };
}

function sanitizeHistory(rawHistory: unknown): UsagePoint[] {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  const now = Date.now();
  return rawHistory
    .map((item, index) => sanitizeHistoryEntry(item, now, rawHistory.length - index))
    .filter((entry): entry is UsagePoint => entry !== null)
    .slice(-USAGE_HISTORY_LIMIT);
}

function sanitizeHistoryEntry(
  value: unknown,
  now: number,
  reverseIndex: number
): UsagePoint | null {
  if (typeof value === "number") {
    const totalTokens = Math.max(0, Math.floor(value));
    return {
      inputTokens: 0,
      outputTokens: totalTokens,
      totalTokens,
      timestamp: new Date(now - reverseIndex * 60_000).toISOString()
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<UsagePoint>;
  const totalTokens = Math.max(0, Math.floor(raw.totalTokens ?? 0));
  const inputTokens = Math.max(0, Math.floor(raw.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(raw.outputTokens ?? 0));
  const parsedTimestamp = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number.NaN;

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    timestamp: Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : new Date(now - reverseIndex * 60_000).toISOString()
  };
}

function calculateTodayTokenUsage(history: UsagePoint[], now: Date): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();

  return history.reduce((sum, entry) => {
    const date = new Date(entry.timestamp);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
      return sum + Math.max(0, Math.floor(entry.totalTokens));
    }
    return sum;
  }, 0);
}

function isTimeoutError(error: string | null): boolean {
  if (!error) {
    return false;
  }
  return /\btimeout|timed out\b/i.test(error);
}
