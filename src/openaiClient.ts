import * as vscode from "vscode";
import { CompletionRequest, OpenAIResponseBody, TokenUsage } from "./types";
import { PromptBuilder } from "./promptBuilder";

interface OpenAICompletionResponse {
  text: string | null;
  error: string | null;
  usage: TokenUsage;
}

export class OpenAIClient {
  private readonly promptBuilder = new PromptBuilder();

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
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
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
        }),
        signal: controller.signal,
      });

      const body = (await response.json()) as OpenAIResponseBody;
      const usage = parseUsage(body);

      if (!response.ok) {
        return {
          text: null,
          error:
            body.error?.message ??
            `OpenAI request failed with status ${response.status}`,
          usage,
        };
      }

      const output = extractOutputText(body);
      return { text: sanitizeCompletion(output), error: null, usage };
    } catch (error) {
      if (didTimeout) {
        return {
          text: null,
          error: `Request timed out after ${request.timeoutMs} ms`,
          usage: emptyUsage(),
        };
      }
      if (controller.signal.aborted || token.isCancellationRequested) {
        return { text: null, error: "Request canceled", usage: emptyUsage() };
      }
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

  return collected.join("").trim();
}

function sanitizeCompletion(text: string): string | null {
  const trimmed = text
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trimEnd();
  return trimmed.length > 0 ? trimmed : null;
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
