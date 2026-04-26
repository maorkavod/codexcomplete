import * as vscode from "vscode";
import { ExtensionConfig, IndentMode } from "./types";

export const EXTENSION_NAMESPACE = "codexComplete";
export const API_KEY_SECRET = "codexComplete.openaiApiKey";
const DEFAULT_IGNORE_PATH_REGEXES = ["env"];

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
  const indentMode = sanitizeIndentMode(cfg.get<string>("indentMode", "smart"));

  return {
    model: cfg.get<string>("model", "gpt-5.3-codex"),
    requestTimeoutMs: clamp(cfg.get<number>("requestTimeoutMs", 15000), 1000, 120000, 15000),
    debounceMs: clamp(cfg.get<number>("debounceMs", 120), 0, 2000, 120),
    maxContextChars: clamp(cfg.get<number>("maxContextChars", 9000), 500, 20000, 9000),
    enableInline: cfg.get<boolean>("enableInline", true),
    includeLeadingLogicComment: cfg.get<boolean>("includeLeadingLogicComment", false),
    indentMode,
    inlineMaxLines: clamp(cfg.get<number>("inlineMaxLines", 8), 1, 64, 8),
    inlineMaxChars: clamp(cfg.get<number>("inlineMaxChars", 700), 32, 4000, 700),
    strictInlineMode: cfg.get<boolean>("strictInlineMode", false),
    dailyTokenLimit: clampNullable(cfg.get<number | null>("dailyTokenLimit", null), 1, 5_000_000),
    ignorePathRegexes: sanitizeStringArray(
      cfg.get<unknown>("ignorePathRegexes", DEFAULT_IGNORE_PATH_REGEXES)
    )
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNullable(value: number | null, min: number, max: number): number | null {
  if (value === null || value === undefined) {
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

function sanitizeIndentMode(value: string): IndentMode {
  if (value === "editor" || value === "language" || value === "smart") {
    return value;
  }
  return "smart";
}
