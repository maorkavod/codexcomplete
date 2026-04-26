import * as vscode from "vscode";
import { CompletionRequest, OpenAIResponseBody, TokenUsage } from "./types";
import { PromptBuilder } from "./promptBuilder";
import { requestJson } from "./httpClient";
import { Logger } from "./logger";
import { processAIResponseCandidate } from "./aiResponsePipeline";

interface OpenAICompletionResponse {
  text: string | null;
  error: string | null;
  usage: TokenUsage;
  debugMeta?: {
    score?: number;
    reason?: string;
  };
}

interface CandidateResponse {
  text: string | null;
  error: string | null;
  usage: TokenUsage;
  status?: number;
  transientFailure?: boolean;
}

const BRACE_LANGUAGES = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "php",
  "swift",
  "kotlin",
  "scala"
]);

const TRANSIENT_COOLDOWN_MS = 2_000;
const RETRY_JITTER_MIN_MS = 120;
const RETRY_JITTER_MAX_MS = 360;

export class OpenAIClient {
  private readonly promptBuilder = new PromptBuilder();
  private readonly logger: Logger;
  private transientFailureStreak = 0;
  private cooldownUntil = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async complete(
    request: CompletionRequest,
    token: vscode.CancellationToken
  ): Promise<OpenAICompletionResponse> {
    if (Date.now() < this.cooldownUntil) {
      const waitMs = this.cooldownUntil - Date.now();
      this.logger.warn(`OpenAI cooldown active; skipping request for ${waitMs}ms`);
      return {
        text: null,
        error: `Cooling down after transient API failures (${waitMs} ms)`,
        usage: emptyUsage(),
        debugMeta: { reason: "cooldown_active" }
      };
    }

    const controller = new AbortController();
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, request.timeoutMs);
    const cancellationSub = token.onCancellationRequested(() => controller.abort());

    try {
      this.logger.debug(
        `OpenAI /responses request starting: model=${request.model} mode=${request.mode} timeoutMs=${request.timeoutMs}`
      );
      const strictInline = request.mode === "inline" && request.strictInlineMode === true;
      const systemPrompt = this.promptBuilder.buildSystemPrompt(
        request.includeLeadingLogicComment,
        strictInline
      );
      const userPrompt = this.promptBuilder.buildUserPrompt(
        request.context,
        request.mode,
        request.includeLeadingLogicComment,
        {
          strictInlineMode: strictInline,
          inlineMaxLines: request.inlineMaxLines,
          inlineMaxChars: request.inlineMaxChars
        }
      );
      const temperatures = candidateTemperatures(request.mode, request.context.languageId, strictInline);
      const maxOutputTokens = maxTokensForMode(
        request.mode,
        request.context.languageId,
        request.inlineMaxChars,
        request.inlineMaxLines
      );
      const settled = await Promise.allSettled(
        temperatures.map((temperature) =>
          this.fetchCandidate(
            request,
            systemPrompt,
            userPrompt,
            temperature,
            maxOutputTokens,
            controller.signal
          )
        )
      );

      let usage = emptyUsage();
      let transientFailures = 0;
      const candidates: Array<{ text: string; score: number }> = [];
      const rawSuccessTexts: string[] = [];
      const errors: string[] = [];

      for (const result of settled) {
        if (result.status !== "fulfilled") {
          const reason = result.reason;
          if (reason instanceof Error) {
            errors.push(reason.message);
          }
          continue;
        }

        const candidate = result.value;
        usage = sumUsage(usage, candidate.usage);
        if (candidate.transientFailure) {
          transientFailures += 1;
        }
        if (candidate.error) {
          errors.push(candidate.error);
          continue;
        }
        if (!candidate.text) {
          continue;
        }
        rawSuccessTexts.push(candidate.text);

        const processed = processAIResponseCandidate(candidate.text, request.context, request.mode, {
          requireLeadingLogicComment: request.includeLeadingLogicComment,
          strictInlineMode: strictInline,
          inlineMaxLines: request.inlineMaxLines,
          inlineMaxChars: request.inlineMaxChars
        });
        if (!processed) {
          continue;
        }
        candidates.push(processed);
      }

      if (candidates.length === 0) {
        if (strictInline && rawSuccessTexts.length > 0) {
          const relaxedCandidates = rawSuccessTexts
            .map((text) =>
              processAIResponseCandidate(text, request.context, request.mode, {
                requireLeadingLogicComment: request.includeLeadingLogicComment,
                strictInlineMode: false,
                inlineMaxLines: request.inlineMaxLines,
                inlineMaxChars: request.inlineMaxChars
              })
            )
            .filter((candidate): candidate is { text: string; score: number } => Boolean(candidate));

          if (relaxedCandidates.length > 0) {
            this.logger.debug(
              `Strict inline fallback accepted relaxed candidate count=${relaxedCandidates.length}`
            );
            const bestRelaxed = relaxedCandidates.sort((a, b) => b.score - a.score)[0];
            return {
              text: bestRelaxed.text,
              error: null,
              usage,
              debugMeta: { score: bestRelaxed.score, reason: "strict_fallback_relaxed" }
            };
          }
        }

        if (rawSuccessTexts.length > 0) {
          const rawFallback = rawSuccessTexts
            .map((text) => salvageRawCandidateText(text, request))
            .find((text): text is string => Boolean(text));
          if (rawFallback) {
            this.logger.warn("All candidates were filtered; using safe raw fallback candidate.");
            return {
              text: rawFallback,
              error: null,
              usage,
              debugMeta: { reason: "fallback_raw_candidate" }
            };
          }
        }

        if (transientFailures > 0) {
          this.recordTransientFailure();
        }
        const firstError = errors.find(Boolean) ?? null;
        return {
          text: null,
          error: firstError,
          usage,
          debugMeta: { reason: transientFailures > 0 ? "transient_failures" : "no_valid_candidates" }
        };
      }

      this.resetTransientFailures();
      const best = candidates.sort((a, b) => b.score - a.score)[0];
      this.logger.debug(
        `OpenAI rerank selected candidate score=${best.score.toFixed(3)} totalCandidates=${candidates.length} totalTokens=${usage.totalTokens}`
      );
      return {
        text: best.text,
        error: null,
        usage,
        debugMeta: { score: best.score, reason: "best_scored_candidate" }
      };
    } catch (error) {
      if (didTimeout) {
        this.recordTransientFailure();
        this.logger.warn(`OpenAI /responses timeout after ${request.timeoutMs}ms`);
        return {
          text: null,
          error: `Request timed out after ${request.timeoutMs} ms`,
          usage: emptyUsage(),
          debugMeta: { reason: "timeout" }
        };
      }
      if (controller.signal.aborted || token.isCancellationRequested) {
        this.logger.debug("OpenAI /responses aborted.");
        return { text: null, error: "Request canceled", usage: emptyUsage() };
      }
      if (isLikelyTransientError(error)) {
        this.recordTransientFailure();
      }
      this.logger.error("OpenAI /responses network error", error);
      return {
        text: null,
        error: error instanceof Error ? error.message : "Unexpected network error",
        usage: emptyUsage(),
        debugMeta: { reason: "network_error" }
      };
    } finally {
      clearTimeout(timeout);
      cancellationSub.dispose();
    }
  }

  private async fetchCandidate(
    request: CompletionRequest,
    systemPrompt: string,
    userPrompt: string,
    temperature: number,
    maxOutputTokens: number,
    signal: AbortSignal
  ): Promise<CandidateResponse> {
    let usage = emptyUsage();
    let attempt = 0;

    while (attempt < 2) {
      try {
        const response = await requestJson<OpenAIResponseBody>("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${request.apiKey}`
          },
          body: {
            model: request.model,
            temperature,
            max_output_tokens: maxOutputTokens,
            input: [
              {
                role: "system",
                content: [{ type: "input_text", text: systemPrompt }]
              },
              {
                role: "user",
                content: [{ type: "input_text", text: userPrompt }]
              }
            ]
          },
          signal
        });

        const body = response.data ?? {};
        const attemptUsage = parseUsage(body);
        usage = sumUsage(usage, attemptUsage);

        if (!response.ok) {
          const transient = isTransientStatus(response.status);
          const errorMessage =
            body.error?.message ?? `OpenAI request failed with status ${response.status}`;
          this.logger.warn(
            `OpenAI candidate non-2xx: status=${response.status} temperature=${temperature} attempt=${attempt + 1}`
          );
          if (transient && attempt === 0 && !signal.aborted) {
            await sleepWithAbortSignal(jitterMs(), signal);
            attempt += 1;
            continue;
          }
          return {
            text: null,
            error: errorMessage,
            usage,
            status: response.status,
            transientFailure: transient
          };
        }

        const output = extractOutputText(body);
        this.logger.debug(
          `OpenAI candidate success: status=${response.status} temperature=${temperature} attempt=${attempt + 1} outputChars=${output.length} totalTokens=${usage.totalTokens}`
        );
        return { text: output, error: null, usage, status: response.status };
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        const transient = isLikelyTransientError(error);
        if (transient && attempt === 0) {
          await sleepWithAbortSignal(jitterMs(), signal);
          attempt += 1;
          continue;
        }
        const message = error instanceof Error ? error.message : "Unexpected network error";
        return { text: null, error: message, usage, transientFailure: transient };
      }
    }

    return {
      text: null,
      error: "Transient API failure after retry",
      usage,
      transientFailure: true
    };
  }

  private recordTransientFailure(): void {
    this.transientFailureStreak += 1;
    if (this.transientFailureStreak >= 2) {
      this.cooldownUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
    }
  }

  private resetTransientFailures(): void {
    this.transientFailureStreak = 0;
    this.cooldownUntil = 0;
  }
}

function extractOutputText(body: OpenAIResponseBody): string {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  const collected: string[] = [];
  for (const outputItem of body.output ?? []) {
    for (const contentItem of outputItem.content ?? []) {
      if (typeof contentItem.text === "string") {
        collected.push(contentItem.text);
      }
    }
  }
  return collected.join("");
}

function parseUsage(body: OpenAIResponseBody): TokenUsage {
  const inputTokens = toSafeInt(body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0);
  const outputTokens = toSafeInt(body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0);
  const reportedTotal = toSafeInt(body.usage?.total_tokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens
  };
}

function toSafeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens
  };
}

function candidateTemperatures(
  mode: CompletionRequest["mode"],
  languageId: string,
  strictInlineMode: boolean
): number[] {
  if (mode !== "inline") {
    return [0.08, 0.18];
  }
  if (strictInlineMode) {
    return [0, 0.04];
  }
  if (languageId === "python" || languageId === "yaml") {
    return [0, 0.05];
  }
  if (isBraceLanguage(languageId)) {
    return [0.03, 0.1];
  }
  return [0.04, 0.14];
}

function maxTokensForMode(
  mode: CompletionRequest["mode"],
  languageId: string,
  inlineMaxChars?: number,
  inlineMaxLines?: number
): number {
  if (mode !== "inline") {
    return 220;
  }
  const linesBound = Math.max(1, Math.min(64, Math.floor(inlineMaxLines ?? 8)));
  const charsBound = Math.max(32, Math.min(4000, Math.floor(inlineMaxChars ?? 700)));
  const safetyCap = Math.max(32, Math.min(220, Math.ceil(charsBound / 4), linesBound * 24));

  if (languageId === "python" || languageId === "yaml") {
    return Math.min(96, safetyCap);
  }
  if (isBraceLanguage(languageId)) {
    return Math.min(128, safetyCap);
  }
  return Math.min(112, safetyCap);
}

function salvageRawCandidateText(text: string, request: CompletionRequest): string | null {
  let value = text
    .replace(/\r\n?/g, "\n")
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/```$/g, "")
    .replace(/<CURSOR>/g, "")
    .trim();
  if (!value) {
    return null;
  }

  const lines = value.split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    if (/^(Here('| i)s|This code|Explanation:|Note:|Sure,|Certainly,|I can|Let's)\b/i.test(trimmed)) {
      return false;
    }
    return true;
  });

  value = cleaned.join("\n").trim();
  if (!value) {
    return null;
  }

  if (request.mode === "inline") {
    const maxLines = Math.max(1, Math.min(64, Math.floor(request.inlineMaxLines ?? 8)));
    const maxChars = Math.max(32, Math.min(4000, Math.floor(request.inlineMaxChars ?? 700)));
    const boundedLines = value.split("\n").slice(0, maxLines);
    value = boundedLines.join("\n");
    if (value.length > maxChars) {
      value = value.slice(0, maxChars);
      value = value.replace(/\n[^\n]*$/, "").trimEnd();
    }
  }

  if (!value.trim()) {
    return null;
  }
  if (/```/.test(value)) {
    return null;
  }
  if (looksMostlyNaturalLanguage(value)) {
    return null;
  }

  return value.trimEnd();
}

function looksMostlyNaturalLanguage(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 12) {
    return false;
  }
  const hasCodeMarkers = /[{}()[\];.=<>]|=>|::|def\s+\w+|class\s+\w+|function\s+\w+|await\s+\w+|return\b/.test(
    text
  );
  if (hasCodeMarkers) {
    return false;
  }
  return /\b(the|and|that|with|this|from|your|should|could|would|because)\b/i.test(text);
}

function isBraceLanguage(languageId: string): boolean {
  return BRACE_LANGUAGES.has(languageId);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function isLikelyTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /timeout|timed out|econnreset|network|fetch failed|temporar/i.test(error.message);
}

function jitterMs(): number {
  return Math.floor(Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS + 1)) + RETRY_JITTER_MIN_MS;
}

async function sleepWithAbortSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Request canceled"));
    };
    signal.addEventListener("abort", onAbort);
  });
}
