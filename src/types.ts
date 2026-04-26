import * as vscode from "vscode";

export type CompletionMode = "inline" | "manual";
export type IndentMode = "editor" | "language" | "smart";

export interface ExtensionConfig {
  model: string;
  requestTimeoutMs: number;
  debounceMs: number;
  maxContextChars: number;
  enableInline: boolean;
  includeLeadingLogicComment: boolean;
  indentMode?: IndentMode;
  inlineMaxLines?: number;
  inlineMaxChars?: number;
  strictInlineMode?: boolean;
  dailyTokenLimit: number | null;
  ignorePathRegexes: string[];
}

export interface EditorIndentation {
  insertSpaces?: boolean;
  tabSize?: number;
}

export interface CompletionContext {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  cursorLinePrefix: string;
  cursorLineSuffix: string;
  recentContext: string;
  upcomingContext: string;
  selectedText?: string;
  insertSpaces?: boolean;
  tabSize?: number;
  detectedIndentUnit?: string;
}

export interface CompletionRequest {
  apiKey: string;
  model: string;
  timeoutMs: number;
  mode: CompletionMode;
  includeLeadingLogicComment: boolean;
  strictInlineMode?: boolean;
  inlineMaxLines?: number;
  inlineMaxChars?: number;
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
  suggestionsShown?: number;
  nullResponses?: number;
  timeoutResponses?: number;
  indentCorrections?: number;
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
  debugMeta?: {
    score?: number;
    reason?: string;
  };
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
