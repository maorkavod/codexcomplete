import * as vscode from "vscode";
import { ExtensionConfig } from "./types";

export const EXTENSION_NAMESPACE = "codexComplete";
export const API_KEY_SECRET = "codexComplete.openaiApiKey";

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);

  return {
    model: cfg.get<string>("model", "gpt-5.3-codex"),
    requestTimeoutMs: clamp(cfg.get<number>("requestTimeoutMs", 15000), 1000, 120000, 15000),
    debounceMs: clamp(cfg.get<number>("debounceMs", 120), 0, 2000, 120),
    maxContextChars: clamp(cfg.get<number>("maxContextChars", 6000), 500, 20000, 6000),
    enableInline: cfg.get<boolean>("enableInline", true),
    dailyTokenLimit: clampNullable(cfg.get<number | null>("dailyTokenLimit", null), 1, 5_000_000)
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
