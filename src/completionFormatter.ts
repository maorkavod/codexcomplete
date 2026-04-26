import { CompletionContext } from "./types";

const BRACE_BLOCK_LANGUAGES = new Set([
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

export function sanitizeAndFormatCompletion(
  text: string,
  context: CompletionContext
): string | null {
  const sanitized = text
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .replace(/\r\n?/g, "\n")
    .trimEnd();

  if (!sanitized) {
    return null;
  }

  return normalizeIndentation(sanitized, context);
}

function normalizeIndentation(text: string, context: CompletionContext): string {
  const prefix = context.prefix.replace(/\r\n?/g, "\n");
  const cursorLinePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const cursorIndent = leadingWhitespace(cursorLinePrefix);
  const atLineStart = cursorLinePrefix.trim().length === 0;
  const indentUnit = detectIndentUnit(prefix, context.languageId);
  const shouldIncrease = shouldIncreaseIndentAfterCursor(prefix, context.languageId);
  const baseIndent = atLineStart && shouldIncrease ? cursorIndent + indentUnit : cursorIndent;
  const lines = text.split("\n");

  if (lines.length === 1) {
    if (atLineStart && lines[0].trim().length > 0) {
      return replaceLeadingWhitespace(lines[0], baseIndent);
    }
    return text;
  }

  const output = [...lines];
  if (atLineStart && output[0].trim().length > 0) {
    output[0] = replaceLeadingWhitespace(output[0], baseIndent);
  }

  const sourceMinIndent = minimumIndent(output.slice(1));
  if (sourceMinIndent === null) {
    return output.join("\n");
  }

  const targetIndent = atLineStart ? baseIndent : cursorIndent;
  for (let i = 1; i < output.length; i += 1) {
    output[i] = shiftIndent(output[i], sourceMinIndent, targetIndent);
  }

  return output.join("\n");
}

function shouldIncreaseIndentAfterCursor(prefix: string, languageId: string): boolean {
  const trimmedPrefix = prefix.trimEnd();
  if (!trimmedPrefix) {
    return false;
  }

  const lastLine = trimmedPrefix.slice(trimmedPrefix.lastIndexOf("\n") + 1);
  const lastLineWithoutComment = languageId === "python" ? lastLine.replace(/#.*/, "") : lastLine;
  const compact = lastLineWithoutComment.trimEnd();

  if (!compact) {
    return false;
  }

  if (languageId === "python") {
    return compact.endsWith(":");
  }

  if (languageId === "yaml") {
    return compact.endsWith(":");
  }

  if (BRACE_BLOCK_LANGUAGES.has(languageId)) {
    return compact.endsWith("{");
  }

  return false;
}

function detectIndentUnit(prefix: string, languageId: string): string {
  const lines = prefix.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => leadingWhitespace(line))
    .filter((indent) => indent.length > 0);

  if (indents.some((indent) => indent.includes("\t"))) {
    return "\t";
  }

  const spaceSizes = indents
    .filter((indent) => /^ +$/.test(indent))
    .map((indent) => indent.length)
    .filter((size) => size > 0);

  if (spaceSizes.length === 0) {
    return " ".repeat(defaultIndentWidth(languageId));
  }

  const inferredWidth = spaceSizes.reduce((acc, size) => gcd(acc, size));
  const width = clampIndentWidth(inferredWidth || defaultIndentWidth(languageId), languageId);
  return " ".repeat(width);
}

function minimumIndent(lines: string[]): number | null {
  let min: number | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indentLength = leadingWhitespace(line).length;
    min = min === null ? indentLength : Math.min(min, indentLength);
  }
  return min;
}

function shiftIndent(line: string, removeCount: number, targetIndent: string): string {
  if (line.trim().length === 0) {
    return "";
  }

  const leading = leadingWhitespace(line);
  const content = line.slice(leading.length);
  const relative = leading.slice(Math.min(removeCount, leading.length));
  return `${targetIndent}${relative}${content}`;
}

function replaceLeadingWhitespace(line: string, targetIndent: string): string {
  return `${targetIndent}${line.trimStart()}`;
}

function leadingWhitespace(value: string): string {
  const match = value.match(/^[\t ]*/);
  return match ? match[0] : "";
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x;
}

function defaultIndentWidth(languageId: string): number {
  if (languageId === "python") {
    return 4;
  }
  return 2;
}

function clampIndentWidth(width: number, languageId: string): number {
  if (languageId === "python" && width < 4) {
    return 4;
  }
  if (width <= 0) {
    return defaultIndentWidth(languageId);
  }
  return Math.min(width, 8);
}
