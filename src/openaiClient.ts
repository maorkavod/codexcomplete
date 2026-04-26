import * as vscode from "vscode";
import { CompletionRequest, OpenAIResponseBody, TokenUsage } from "./types";
import { PromptBuilder } from "./promptBuilder";
import { requestJson } from "./httpClient";
import { Logger } from "./logger";
import { sanitizeAndFormatCompletion } from "./completionFormatter";

interface OpenAICompletionResponse {
  text: string | null;
  error: string | null;
  usage: TokenUsage;
}

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
      const response = await requestJson<OpenAIResponseBody>("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${request.apiKey}`
        },
        body: {
          model: request.model,
          temperature: 0.15,
          max_output_tokens: request.mode === "inline" ? 96 : 220,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: this.promptBuilder.buildSystemPrompt(),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: this.promptBuilder.buildUserPrompt(
                    request.context,
                    request.mode,
                  ),
                },
              ],
            },
          ],
        },
        signal: controller.signal
      });

      const body = response.data ?? {};
      const usage = parseUsage(body);

      if (!response.ok) {
        this.logger.warn(`OpenAI /responses returned non-2xx status=${response.status}`);
        return {
          text: null,
          error:
            body.error?.message ??
            `OpenAI request failed with status ${response.status}`,
          usage,
        };
      }

      const output = extractOutputText(body);
      this.logger.debug(
        `OpenAI /responses success: status=${response.status} outputChars=${output.length} totalTokens=${usage.totalTokens}`
      );
      return {
        text: sanitizeAndFormatCompletion(output, request.context),
        error: null,
        usage
      };
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
