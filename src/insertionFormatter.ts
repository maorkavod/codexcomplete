import { CompletionContext, CompletionMode, IndentMode } from "./types";

interface InsertionFormatterOptions {
  indentMode: IndentMode;
  mode: CompletionMode;
}

export interface InsertionFormatResult {
  text: string | null;
  corrected: boolean;
}

export function formatInsertionText(
  rawText: string | null,
  context: CompletionContext,
  options: InsertionFormatterOptions
): InsertionFormatResult {
  if (!rawText) {
    return { text: null, corrected: false };
  }

  const normalizedNewlines = rawText.replace(/\r\n?/g, "\n");
  if (!normalizedNewlines.trim()) {
    return { text: null, corrected: false };
  }

  const lines = normalizedNewlines.split("\n");
  const tabSize = sanitizeTabSize(context.tabSize);
  const unit = resolveIndentUnit(context, options.indentMode);

  let corrected = false;
  const convertedLines = lines.map((line) => {
    if (!line || !/^[\t ]+/.test(line)) {
      return line;
    }

    const leading = leadingWhitespace(line);
    const columns = indentColumns(leading, tabSize);
    const rebuilt = columnsToIndent(columns, unit, tabSize);
    if (rebuilt !== leading) {
      corrected = true;
    }
    return `${rebuilt}${line.slice(leading.length)}`;
  });

  const text = convertedLines.join("\n").replace(/[ \t]+$/gm, "").trimEnd();
  return { text: text.trim() ? text : null, corrected };
}

export function detectIndentUnitFromText(
  sourceText: string,
  languageId: string,
  preferredTabSize?: number
): string {
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => leadingWhitespace(line))
    .filter((indent) => indent.length > 0);

  if (indents.length === 0) {
    return defaultIndentUnit(languageId, preferredTabSize);
  }

  if (indents.some((indent) => indent.includes("\t"))) {
    return "\t";
  }

  const sizes = indents
    .filter((indent) => /^ +$/.test(indent))
    .map((indent) => indent.length)
    .filter((size) => size > 0);

  if (sizes.length === 0) {
    return defaultIndentUnit(languageId, preferredTabSize);
  }

  const uniqueSorted = [...new Set(sizes)].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < uniqueSorted.length; i += 1) {
    const delta = uniqueSorted[i] - uniqueSorted[i - 1];
    if (delta > 0) {
      deltas.push(delta);
    }
  }

  const basis = deltas.length > 0 ? deltas : sizes;
  let divisor = basis[0];
  for (let i = 1; i < basis.length; i += 1) {
    divisor = gcd(divisor, basis[i]);
  }

  divisor = Math.max(1, divisor);
  if (languageId === "python" && (divisor > 4 || divisor === 3)) {
    divisor = 4;
  }
  if (languageId !== "python" && divisor > 8) {
    divisor = sanitizeTabSize(preferredTabSize);
  }
  return " ".repeat(divisor);
}

function resolveIndentUnit(context: CompletionContext, mode: IndentMode): string {
  const detected = context.detectedIndentUnit;
  const editorUnit =
    context.insertSpaces === false ? "\t" : " ".repeat(sanitizeTabSize(context.tabSize));
  const languageUnit = detected && detected.length > 0 ? detected : defaultIndentUnit(context.languageId);

  if (mode === "editor") {
    return editorUnit;
  }
  if (mode === "language") {
    return languageUnit;
  }

  if (detected === "\t" && context.insertSpaces !== true) {
    return "\t";
  }
  if (detected && detected !== "\t" && context.insertSpaces === true) {
    return detected;
  }
  return editorUnit;
}

function defaultIndentUnit(languageId: string, preferredTabSize?: number): string {
  if (languageId === "python") {
    return "    ";
  }
  const tabSize = sanitizeTabSize(preferredTabSize);
  return " ".repeat(Math.min(4, Math.max(2, tabSize)));
}

function sanitizeTabSize(value?: number): number {
  if (!Number.isFinite(value)) {
    return 4;
  }
  return Math.max(1, Math.min(8, Math.floor(value ?? 4)));
}

function leadingWhitespace(value: string): string {
  const match = value.match(/^[\t ]*/);
  return match ? match[0] : "";
}

function indentColumns(indent: string, tabSize: number): number {
  let count = 0;
  for (const char of indent) {
    count += char === "\t" ? tabSize : 1;
  }
  return count;
}

function columnsToIndent(columns: number, unit: string, tabSize: number): string {
  if (columns <= 0) {
    return "";
  }
  if (unit === "\t") {
    const tabs = Math.floor(columns / tabSize);
    const spaces = columns % tabSize;
    return `${"\t".repeat(tabs)}${" ".repeat(spaces)}`;
  }
  return " ".repeat(columns);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}
