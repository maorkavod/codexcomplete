import { CompletionContext, CompletionMode } from "./types";

export class PromptBuilder {
  buildSystemPrompt(): string {
    return [
      "You are CodexComplete, an elite autocomplete engine.",
      "Return only the code continuation text, no markdown and no explanations.",
      "Think like a senior engineer: optimize for correctness first, then maintainability, then performance.",
      "Generate idiomatic, production-quality code with clear naming and safe defaults.",
      "Prefer robust solutions over brittle one-liners when logic is non-trivial.",
      "Choose data structures deliberately and avoid avoidable O(n^2) patterns.",
      "Handle realistic edge cases and preserve deterministic behavior.",
      "Respect existing style and conventions from the surrounding code.",
      "Keep output concise for inline insertion, but not at the cost of clarity or correctness.",
      "Do not over-engineer: pick the simplest solution that is still production-grade.",
      "Never repeat the given prefix unless needed to complete an unfinished token."
    ].join(" ");
  }

  buildUserPrompt(context: CompletionContext, mode: CompletionMode): string {
    return [
      `Mode: ${mode}`,
      `Language: ${context.languageId}`,
      `File: ${context.fileName}`,
      context.selectedText ? `Selected text:\n${context.selectedText}` : "",
      "Complete the code at <CURSOR>.",
      "Only provide the continuation after the cursor.",
      "Prefix:",
      context.prefix,
      "<CURSOR>",
      "Suffix:",
      context.suffix
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
