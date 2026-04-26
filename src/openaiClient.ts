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
}

interface CandidateResponse {
  text: string | null;
  error: string | null;
  usage: TokenUsage;
  status?: number;
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

export class OpenAIClient {
  private readonly promptBuilder = new PromptBuilder();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async complete(
    request: CompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<OpenAICompletionResponse> {
    const controller = new AbortController();
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, request.timeoutMs);
    const cancellationSub = token.onCancellationRequested(() =>
      controller.abort(),
    );

    try {
      this.logger.debug(
        `OpenAI /responses request starting: model=${request.model} mode=${request.mode} timeoutMs=${request.timeoutMs}`
      );
      const systemPrompt = this.promptBuilder.buildSystemPrompt(
        request.includeLeadingLogicComment
      );
      const userPrompt = this.promptBuilder.buildUserPrompt(
        request.context,
        request.mode,
        request.includeLeadingLogicComment
      );
      const temperatures = candidateTemperatures(request.mode, request.context.languageId);
      const maxOutputTokens = maxTokensForMode(request.mode, request.context.languageId);
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
      const candidates: Array<{ text: string; score: number }> = [];
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
        if (candidate.error) {
          errors.push(candidate.error);
          continue;
        }
        if (!candidate.text) {
          continue;
        }

        const processed = processAIResponseCandidate(
          candidate.text,
          request.context,
          request.mode,
          { requireLeadingLogicComment: request.includeLeadingLogicComment }
        );
        if (!processed) {
          continue;
        }
        candidates.push(processed);
      }

      if (candidates.length === 0) {
        const firstError = errors.find(Boolean) ?? null;
        return { text: null, error: firstError, usage };
      }

      const best = candidates.sort((a, b) => b.score - a.score)[0];
      this.logger.debug(
        `OpenAI rerank selected candidate score=${best.score.toFixed(3)} totalCandidates=${candidates.length} totalTokens=${usage.totalTokens}`
      );
      return { text: best.text, error: null, usage };
    } catch (error) {
      if (didTimeout) {
        this.logger.warn(`OpenAI /responses timeout after ${request.timeoutMs}ms`);
        return {
          text: null,
          error: `Request timed out after ${request.timeoutMs} ms`,
          usage: emptyUsage(),
        };
      }
      if (controller.signal.aborted || token.isCancellationRequested) {
        this.logger.debug("OpenAI /responses aborted.");
        return { text: null, error: "Request canceled", usage: emptyUsage() };
      }
      this.logger.error("OpenAI /responses network error", error);
      return {
        text: null,
        error:
          error instanceof Error ? error.message : "Unexpected network error",
        usage: emptyUsage(),
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
            content: [
              {
                type: "input_text",
                text: systemPrompt,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: userPrompt,
              },
            ],
          },
        ],
      },
      signal
    });

    const body = response.data ?? {};
    const usage = parseUsage(body);
    if (!response.ok) {
      this.logger.warn(
        `OpenAI /responses candidate non-2xx status=${response.status} temperature=${temperature}`
      );
      return {
        text: null,
        error: body.error?.message ?? `OpenAI request failed with status ${response.status}`,
        usage,
        status: response.status
      };
    }

    const output = extractOutputText(body);
    this.logger.debug(
      `OpenAI /responses candidate success: status=${response.status} temperature=${temperature} outputChars=${output.length} totalTokens=${usage.totalTokens}`
    );
    return { text: output, error: null, usage, status: response.status };
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
  const inputTokens = toSafeInt(
    body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
  );
  const outputTokens = toSafeInt(
    body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
  );
  const reportedTotal = toSafeInt(body.usage?.total_tokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
  };
}

function toSafeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function candidateTemperatures(mode: CompletionRequest["mode"], languageId: string): number[] {
  if (mode !== "inline") {
    return [0.08, 0.18];
  }
  if (languageId === "python" || languageId === "yaml") {
    return [0, 0.05];
  }
  if (isBraceLanguage(languageId)) {
    return [0.03, 0.1];
  }
  return [0.04, 0.14];
}

function maxTokensForMode(mode: CompletionRequest["mode"], languageId: string): number {
  if (mode !== "inline") {
    return 220;
  }
  if (languageId === "python" || languageId === "yaml") {
    return 64;
  }
  if (isBraceLanguage(languageId)) {
    return 88;
  }
  return 80;
}

function isBraceLanguage(languageId: string): boolean {
  return BRACE_LANGUAGES.has(languageId);
}
