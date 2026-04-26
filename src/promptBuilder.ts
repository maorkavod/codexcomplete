import { CompletionContext, CompletionMode } from "./types";

export class PromptBuilder {
  buildSystemPrompt(includeLeadingLogicComment: boolean, strictInlineMode = false): string {
    return [
      "You are CodexComplete, an elite autocomplete engine.",
      "Return only the code continuation text, no markdown and no explanations.",
      "If you are not confident in a high-quality continuation, return an empty string.",
      "Think like a senior engineer: optimize for correctness first, then maintainability, then performance.",
      "Generate idiomatic, production-quality code with clear naming and safe defaults.",
      "Prefer robust solutions over brittle one-liners when logic is non-trivial.",
      "Choose data structures deliberately and avoid avoidable O(n^2) patterns.",
      "Handle realistic edge cases and preserve deterministic behavior.",
      "Respect existing style and conventions from the surrounding code.",
      "Keep output concise for inline insertion, but not at the cost of clarity or correctness.",
      "Do not over-engineer: pick the simplest solution that is still production-grade.",
      "Never repeat the given prefix unless needed to complete an unfinished token.",
      "Never duplicate branch conditions or emit structurally invalid control-flow.",
      "Preserve correct indentation and line breaks for the target language.",
      "Stay in the current local scope; do not jump to unrelated code outside the block near <CURSOR>.",
      "For Python, keep block shape valid: if/elif/else and try/except/finally must align at the same indentation depth.",
      "For Python, never place elif/else/except/finally inside the previous body block by mistake.",
      includeLeadingLogicComment
        ? "The first non-empty completion line must be a short comment explaining the added logic."
        : "Do not add explanatory comments unless they are clearly useful.",
      strictInlineMode
        ? "Strict inline mode is enabled: continue minimally, avoid speculative edits, never narrate."
        : "Continue naturally while staying local and precise.",
      strictInlineMode
        ? "Hard ban: no prose lines, no markdown fences, no duplicate prefix/suffix echoes."
        : "Prefer local continuity over broad rewrites.",
      "When unsure, emit fewer lines rather than speculative extra code."
    ].join(" ");
  }

  buildUserPrompt(
    context: CompletionContext,
    mode: CompletionMode,
    includeLeadingLogicComment: boolean,
    options?: {
      strictInlineMode?: boolean;
      inlineMaxLines?: number;
      inlineMaxChars?: number;
    }
  ): string {
    const cursorIndent = leadingWhitespace(context.cursorLinePrefix);
    const lineStart = context.cursorLinePrefix.trim().length === 0;
    const previousNonEmptyLine = getPreviousNonEmptyLine(context.prefix);
    const targetIndentHint = computeTargetIndentHint(context);
    const strictInlineMode = options?.strictInlineMode === true;
    const inlineMaxLines = options?.inlineMaxLines ?? 8;
    const inlineMaxChars = options?.inlineMaxChars ?? 700;

    return [
      `Mode: ${mode}`,
      `Language: ${context.languageId}`,
      `File: ${context.fileName}`,
      `Cursor at line start: ${lineStart}`,
      `Cursor indentation chars: ${cursorIndent.length}`,
      `Previous non-empty line: ${previousNonEmptyLine}`,
      context.selectedText ? `Selected text:\n${context.selectedText}` : "",
      "Complete the code at <CURSOR>.",
      "Only provide the continuation after the cursor.",
      `Target indentation for first continuation line: ${targetIndentHint} spaces`,
      "Hard constraints:",
      "- Never duplicate an existing condition in if/elif.",
      "- Never output malformed merged tokens (example: Falseelif).",
      "- Keep continuation inside the nearest local block.",
      includeLeadingLogicComment
        ? "- First non-empty line must be a comment summarizing the logic."
        : "- Avoid unnecessary comments.",
      "- If quality is uncertain, output an empty string.",
      mode === "inline"
        ? `Inline mode rules: prefer 1-4 lines, stay in the same syntactic block, avoid broad continuations. Hard limit ${inlineMaxLines} lines and ${inlineMaxChars} chars.`
        : "Manual mode rules: continue naturally, but preserve local structure and indentation.",
      strictInlineMode && mode === "inline"
        ? "Strict inline constraints: output only the immediate continuation; do not add imports, module-level declarations, or explanatory text."
        : "",
      "Local line before cursor:",
      context.cursorLinePrefix,
      "<CURSOR>",
      "Local line after cursor:",
      context.cursorLineSuffix,
      context.recentContext ? `Top buffer (unchanged context above cursor):\n${context.recentContext}` : "",
      context.upcomingContext ? `Bottom buffer (unchanged context below cursor):\n${context.upcomingContext}` : "",
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

function getPreviousNonEmptyLine(prefix: string): string {
  const lines = prefix.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      return lines[i];
    }
  }
  return "";
}

function leadingWhitespace(value: string): string {
  const match = value.match(/^[\t ]*/);
  return match ? match[0] : "";
}

function computeTargetIndentHint(context: CompletionContext): number {
  const cursorIndent = leadingWhitespace(context.cursorLinePrefix).length;
  if (
    context.languageId === "python" &&
    context.cursorLinePrefix.trim().length > 0 &&
    context.cursorLineSuffix.trim().length === 0 &&
    context.cursorLinePrefix.trimEnd().endsWith(":")
  ) {
    return cursorIndent + 4;
  }
  return cursorIndent;
}
