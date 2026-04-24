import * as vscode from "vscode";
import { ContextCollector } from "./contextCollector";
import { OpenAIClient } from "./openaiClient";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import {
  CompletionMode,
  CompletionResult,
  ConfigProvider,
  DiagnosticsState,
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

  private cache = new Map<string, { value: string; ts: number }>();
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
  }) {
    this.client = options.client;
    this.collector = options.collector;
    this.getConfig = options.getConfig;
    this.getApiKey = options.getApiKey;
    this.diagnosticsPanel = options.diagnosticsPanel;
    this.usageStats = sanitizeUsageStats(options.initialUsageStats);
    this.saveUsageStats = options.saveUsageStats;
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
  }): Promise<CompletionResult> {
    const config = this.getConfig();
    const start = Date.now();

    if (shouldIgnoreDocument(params.document, config.ignorePathRegexes)) {
      return {
        text: null,
        diagnostics: this.diag(config.model, start, null)
      };
    }

    if (params.mode === "inline" && !config.enableInline) {
      return {
        text: null,
        diagnostics: this.diag(config.model, start, null)
      };
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      const diagnostics = this.diag(config.model, start, "Missing API key");
      this.diagnosticsPanel.update(diagnostics);
      return { text: null, diagnostics };
    }

    const context = this.collector.collect(
      params.document,
      params.position,
      config.maxContextChars,
      params.selectedText
    );

    const cacheKey = buildCacheKey(config.model, params.mode, context.prefix, context.suffix);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      const diagnostics = this.diag(config.model, start, null);
      this.diagnosticsPanel.update(diagnostics);
      return { text: cached.value, diagnostics };
    }

    if (params.mode === "inline") {
      await wait(config.debounceMs, params.token);
      if (params.token.isCancellationRequested) {
        const diagnostics = this.diag(config.model, start, "Request canceled");
        this.diagnosticsPanel.update(diagnostics);
        return { text: null, diagnostics };
      }
    }

    if (config.dailyTokenLimit !== null) {
      const usedToday = calculateTodayTokenUsage(this.usageStats.history, new Date());
      if (usedToday >= config.dailyTokenLimit) {
        const diagnostics = this.diag(
          config.model,
          start,
          `Daily token limit reached (${usedToday}/${config.dailyTokenLimit}).`
        );
        this.diagnosticsPanel.update(diagnostics);
        return { text: null, diagnostics };
      }
    }

    const nonce = ++this.requestNonce;
    const response = await this.client.complete(
      {
        apiKey,
        model: config.model,
        timeoutMs: config.requestTimeoutMs,
        mode: params.mode,
        context
      },
      params.token
    );

    if (params.token.isCancellationRequested || nonce !== this.requestNonce) {
      const diagnostics = this.diag(config.model, start, "Request canceled");
      this.diagnosticsPanel.update(diagnostics);
      return { text: null, diagnostics };
    }

    this.consumeUsage(response.usage);

    const diagnostics = this.diag(config.model, start, response.error);
    this.diagnosticsPanel.update(diagnostics);

    if (response.text) {
      this.cache.set(cacheKey, { value: response.text, ts: Date.now() });
    }

    return {
      text: response.text,
      diagnostics
    };
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
    if (
      date.getFullYear() === year &&
      date.getMonth() === month &&
      date.getDate() === day
    ) {
      return sum + Math.max(0, Math.floor(entry.totalTokens));
    }
    return sum;
  }, 0);
}
