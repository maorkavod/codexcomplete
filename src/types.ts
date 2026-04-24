import * as vscode from "vscode";

export type CompletionMode = "inline" | "manual";

export interface ExtensionConfig {
  model: string;
  requestTimeoutMs: number;
  debounceMs: number;
  maxContextChars: number;
  enableInline: boolean;
  dailyTokenLimit: number | null;
  ignorePathRegexes: string[];
}

export interface CompletionContext {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  selectedText?: string;
}

export interface CompletionRequest {
  apiKey: string;
  model: string;
  timeoutMs: number;
  mode: CompletionMode;
  context: CompletionContext;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastTotalTokens: number;
  history: UsagePoint[];
}

export interface UsagePoint {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: string;
}

export interface DiagnosticsState {
  model: string;
  latencyMs: number;
  lastError: string | null;
  lastUpdated: string;
  usage: UsageStats;
}

export interface CompletionResult {
  text: string | null;
  diagnostics: DiagnosticsState;
}

export interface OpenAIResponseBody {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export type ConfigProvider = () => ExtensionConfig;
export type Token = vscode.CancellationToken;
