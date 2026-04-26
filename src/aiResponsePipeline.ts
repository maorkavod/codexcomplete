import { CompletionContext, CompletionMode } from "./types";

export interface ProcessedCandidate {
  text: string;
  score: number;
}

interface PipelineOptions {
  requireLeadingLogicComment?: boolean;
}

export function processAIResponseCandidate(
  rawText: string,
  context: CompletionContext,
  mode: CompletionMode,
  options?: PipelineOptions,
): ProcessedCandidate | null {
  const sanitized = sanitizeRawModelText(rawText);
  if (!sanitized) {
    return null;
  }

  const withoutEcho = removeRepeatedPrefixEcho(sanitized, context.prefix);
  if (!withoutEcho.trim()) {
    return null;
  }

  const languageNormalized = normalizeByLanguage(withoutEcho, context);
  const anchored = anchorCandidateToCursor(languageNormalized, context);
  if (!anchored) {
    return null;
  }

  const structureNormalized = normalizeAnchoredStructure(anchored, context);
  if (!structureNormalized.trim()) {
    return null;
  }
  const commentNormalized = options?.requireLeadingLogicComment
    ? normalizeLeadingCommentBlock(structureNormalized, context.languageId)
    : structureNormalized;
  if (
    options?.requireLeadingLogicComment &&
    !hasLeadingLogicComment(commentNormalized, context.languageId)
  ) {
    return null;
  }

  if (!isCandidateValid(commentNormalized, context, mode)) {
    return null;
  }

  const score = scoreCandidate(commentNormalized, context, mode);
  const minScore = mode === "inline" ? 0.58 : 0.45;
  if (score < minScore) {
    return null;
  }

  return { text: commentNormalized, score };
}

function hasLeadingLogicComment(text: string, languageId: string): boolean {
  const firstLine = firstNonEmptyLine(text);
  if (!firstLine) {
    return false;
  }
  const trimmed = firstLine.trimStart();
  const token = commentTokenForLanguage(languageId);
  if (!token) {
    return true;
  }
  return trimmed.startsWith(token);
}

function commentTokenForLanguage(languageId: string): string | null {
  if (
    languageId === "python" ||
    languageId === "yaml" ||
    languageId === "shellscript"
  ) {
    return "#";
  }
  if (languageId === "html" || languageId === "xml") {
    return "<!--";
  }
  if (languageId === "sql") {
    return "--";
  }
  if (languageId === "json" || languageId === "jsonc") {
    return null;
  }
  return "//";
}

function lineCommentTokenForLanguage(languageId: string): string | null {
  const token = commentTokenForLanguage(languageId);
  if (token === "<!--") {
    return null;
  }
  return token;
}

function normalizeLeadingCommentBlock(text: string, languageId: string): string {
  const token = lineCommentTokenForLanguage(languageId);
  if (!token) {
    return text;
  }

  const lines = text.split("\n");
  let firstNonEmptyIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length > 0) {
      firstNonEmptyIndex = i;
      break;
    }
  }
  if (firstNonEmptyIndex < 0) {
    return text;
  }

  if (!lines[firstNonEmptyIndex].trimStart().startsWith(token)) {
    return text;
  }

  for (let i = firstNonEmptyIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      break;
    }
    if (trimmed.startsWith(token)) {
      continue;
    }
    if (!isLikelyNaturalLanguageCommentContinuation(trimmed, languageId)) {
      break;
    }
    const indent = leadingWhitespace(lines[i]);
    lines[i] = `${indent}${token} ${trimmed}`;
  }

  return lines.join("\n");
}

function isLikelyNaturalLanguageCommentContinuation(
  trimmed: string,
  languageId: string,
): boolean {
  if (/[`{}()[\];=<>\\]/.test(trimmed)) {
    return false;
  }
  if (/^\/\*|\*\/|^\*/.test(trimmed)) {
    return false;
  }
  if (/^["'`]/.test(trimmed)) {
    return false;
  }
  if (/^\w+\s*[:=]\s*/.test(trimmed)) {
    return false;
  }
  if (
    /^(if|else|elif|except|finally|switch|case|return|await|throw|try|catch|const|let|var|function|class|def|import|from|new|public|private|protected|interface|type|enum)\b/.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (/^(for|while)\b/.test(trimmed)) {
    if (/[({]/.test(trimmed) || /\bin\b/.test(trimmed) || trimmed.endsWith(":")) {
      return false;
    }
  }
  if (
    languageId === "python" &&
    /^(pass|break|continue|raise|with|async)\b/.test(trimmed)
  ) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9,'"._-]*(\s+[A-Za-z0-9,'"._-]+)+[.!?]?$/.test(
    trimmed,
  );
}

function sanitizeRawModelText(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n");
  const withoutFence = normalized
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/```$/g, "")
    .replace(/<CURSOR>/g, "");
  const clipped = clipExplanationTail(withoutFence).trimEnd();
  const lines = dropLeadingEmptyLines(clipped.split("\n"));
  const output = lines.join("\n").trimEnd();
  return output.trim() ? output : null;
}

function removeRepeatedPrefixEcho(text: string, prefix: string): string {
  const prefixTail = prefix.slice(-260);
  if (!prefixTail) {
    return text;
  }

  const maxLength = Math.min(prefixTail.length, text.length, 160);
  for (let length = maxLength; length >= 8; length -= 1) {
    if (prefixTail.slice(-length) === text.slice(0, length)) {
      return text.slice(length).trimStart();
    }
  }

  return text;
}

function anchorCandidateToCursor(
  text: string,
  context: CompletionContext,
): string | null {
  const lines = dropLeadingEmptyLines(text.split("\n"));
  if (lines.length === 0) {
    return null;
  }

  const modelBaseIndent = minimumIndent(lines);
  const relativeLines = lines.map((line) =>
    stripLeadingIndent(line, modelBaseIndent),
  );

  const baselineIndent = inferBaselineIndent(context);
  const firstLinePrefix = inferFirstLinePrefix(context, baselineIndent);
  const forceLeadingNewline = shouldForceLeadingNewline(context);

  const output: string[] = [];
  for (let i = 0; i < relativeLines.length; i += 1) {
    const line = relativeLines[i];
    if (!line.trim()) {
      output.push("");
      continue;
    }
    if (i === 0) {
      if (forceLeadingNewline) {
        output.push(`\n${baselineIndent}${line.trimStart()}`);
        continue;
      }
      output.push(`${firstLinePrefix}${line}`);
      continue;
    }
    output.push(`${baselineIndent}${line}`);
  }

  const result = removeConsecutiveDuplicateLines(output.join("\n").trimEnd());
  return result.trim() ? result : null;
}

function inferFirstLinePrefix(
  context: CompletionContext,
  baselineIndent: string,
): string {
  const cursorPrefix = context.cursorLinePrefix;
  const isWhitespaceOnly = cursorPrefix.trim().length === 0;
  if (!isWhitespaceOnly) {
    return "";
  }
  if (cursorPrefix.length > 0) {
    // The cursor is already positioned inside existing indentation.
    // Avoid adding baseline indentation again to line 1.
    return "";
  }
  return baselineIndent;
}

function inferBaselineIndent(context: CompletionContext): string {
  const cursorPrefix = context.cursorLinePrefix;
  const prefix = context.prefix.replace(/\r\n?/g, "\n");
  const indentUnit = detectIndentUnit(prefix, context.languageId);

  if (shouldForceLeadingNewline(context)) {
    const currentIndent = leadingWhitespace(cursorPrefix);
    if (isPythonBlockLineAtCursor(context)) {
      return `${currentIndent}${indentUnit}`;
    }
    return currentIndent;
  }

  if (cursorPrefix.trim().length !== 0) {
    return "";
  }
  if (cursorPrefix.length > 0) {
    return leadingWhitespace(cursorPrefix);
  }

  const suffix = context.suffix.replace(/\r\n?/g, "\n");
  const previous = findLastNonEmptyLine(prefix);
  const upcoming = firstNonEmptyLine(suffix);

  if (!previous) {
    return "";
  }

  let baseline = leadingWhitespace(previous);
  const previousTrimmed = previous.trim();
  if (opensBlock(previousTrimmed, context.languageId)) {
    baseline = `${baseline}${indentUnit}`;
  }

  if (upcoming) {
    const upcomingTrimmed = upcoming.trimStart();
    const upcomingIndent = leadingWhitespace(upcoming);
    if (startsWithCloser(upcomingTrimmed, context.languageId)) {
      return upcomingIndent;
    }
    if (upcomingIndent.length > 0 && baseline.length > upcomingIndent.length) {
      return upcomingIndent;
    }
  }

  return baseline;
}

function opensBlock(trimmedLine: string, languageId: string): boolean {
  if (!trimmedLine) {
    return false;
  }
  if (trimmedLine.endsWith(":")) {
    return true;
  }
  if (/[{[(]\s*$/.test(trimmedLine)) {
    return true;
  }
  if (languageId === "lua" && /\bthen\s*$/.test(trimmedLine)) {
    return true;
  }
  return false;
}

function startsWithCloser(trimmedLine: string, languageId: string): boolean {
  if (/^[}\])]/.test(trimmedLine)) {
    return true;
  }
  if (languageId === "python" || languageId === "yaml") {
    return /^(except|elif|else|finally)\b/.test(trimmedLine);
  }
  return false;
}

function shouldForceLeadingNewline(context: CompletionContext): boolean {
  if (context.languageId !== "python") {
    return false;
  }
  if (context.cursorLineSuffix.trim().length > 0) {
    return false;
  }
  if (context.cursorLinePrefix.trim().length === 0) {
    return false;
  }
  // Python inline completions at EOL should continue on the next line.
  return true;
}

function isPythonBlockLineAtCursor(context: CompletionContext): boolean {
  return /:\s*(#.*)?$/.test(context.cursorLinePrefix.trimEnd());
}

function normalizeByLanguage(text: string, context: CompletionContext): string {
  if (context.languageId !== "python") {
    return text;
  }
  return text
    .replace(/(\S)\s*(?=(elif|else|except|finally)\s*:)/g, "$1\n")
    .replace(/([)\}"'])(?=[A-Za-z_][A-Za-z0-9_]*\s*\()/g, "$1\n")
    .replace(
      /([A-Za-z0-9_\]\)'""])\s*(?=(elif|else|except|finally)\b)/g,
      "$1\n",
    )
    .replace(
      /([A-Za-z0-9_\]\)'""])\s*(?=(for|while|try|with|return|await|raise)\b)/g,
      "$1\n",
    );
}

function normalizeAnchoredStructure(
  text: string,
  context: CompletionContext,
): string {
  if (context.languageId !== "python") {
    return text;
  }
  return normalizePythonIndentShape(text, context);
}

function normalizePythonIndentShape(
  text: string,
  context: CompletionContext,
): string {
  const lines = text.split("\n");
  const baseline = inferBaselineIndent(context);
  const baselineSize = baseline.length;
  const indentUnit = detectIndentUnit(
    context.prefix.replace(/\r\n?/g, "\n"),
    context.languageId,
  );
  const unitSize = indentUnit.includes("\t")
    ? 4
    : Math.max(1, indentUnit.length);
  const preserveFirstLineAtCursor =
    context.cursorLinePrefix.trim().length === 0 &&
    context.cursorLinePrefix.length > 0;
  const firstControlIndent = inferFirstPythonControlIndent(
    lines,
    context,
    preserveFirstLineAtCursor,
  );
  const controlBodyIndent =
    firstControlIndent === null ? null : firstControlIndent + unitSize;
  const blockLineAtCursor = isPythonBlockLineAtCursor(context);

  const fixed: string[] = [];
  let pendingBodyIndent: number | null = null;
  let previousSignificant: { indent: number; trimmed: string } | null = null;
  let seenSignificantLine = false;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim()) {
      fixed.push(rawLine);
      continue;
    }

    const indent = leadingWhitespace(rawLine).length;
    const trimmed = rawLine.trimStart();
    const isBranch = /^(elif|else|except|finally)\b/.test(trimmed);
    let targetIndent = indent;
    if (!seenSignificantLine && isBranch) {
      targetIndent = inferBranchIndentFromContext(context, unitSize);
    }
    if (!seenSignificantLine && preserveFirstLineAtCursor) {
      const normalized = trimmed;
      fixed.push(normalized);
      previousSignificant = {
        indent: leadingWhitespace(context.cursorLinePrefix).length,
        trimmed,
      };
      pendingBodyIndent = trimmed.endsWith(":") ? unitSize : null;
      seenSignificantLine = true;
      continue;
    }
    if (
      pendingBodyIndent !== null &&
      !isBranch &&
      targetIndent < pendingBodyIndent
    ) {
      targetIndent = pendingBodyIndent;
    }
    if (isBranch && firstControlIndent !== null) {
      targetIndent = firstControlIndent;
    }
    if (
      i > 0 &&
      controlBodyIndent !== null &&
      !isBranch &&
      targetIndent < controlBodyIndent
    ) {
      targetIndent = controlBodyIndent;
    }
    if (!seenSignificantLine && !isBranch && blockLineAtCursor) {
      const cursorIndent = leadingWhitespace(context.cursorLinePrefix).length;
      targetIndent = Math.max(targetIndent, cursorIndent + unitSize);
    }
    const minIndent = isBranch
      ? Math.max(0, baselineSize - unitSize)
      : baselineSize;

    if (targetIndent < minIndent) {
      targetIndent = minIndent;
    }

    if (targetIndent > baselineSize + unitSize * 2) {
      targetIndent = baselineSize + unitSize;
    }

    if (
      previousSignificant &&
      targetIndent > previousSignificant.indent &&
      !opensBlock(previousSignificant.trimmed, context.languageId)
    ) {
      targetIndent = previousSignificant.indent;
    }

    const normalized = `${" ".repeat(Math.max(0, targetIndent))}${trimmed}`;
    fixed.push(normalized);
    previousSignificant = { indent: Math.max(0, targetIndent), trimmed };
    seenSignificantLine = true;
    if (isBranch && firstControlIndent !== null) {
      pendingBodyIndent = firstControlIndent + unitSize;
      continue;
    }
    if (pendingBodyIndent !== null && !isBranch && indent < pendingBodyIndent) {
      pendingBodyIndent = trimmed.endsWith(":")
        ? pendingBodyIndent + unitSize
        : null;
      continue;
    }
    pendingBodyIndent = trimmed.endsWith(":")
      ? Math.max(0, targetIndent) + unitSize
      : null;
  }

  const deduped = removeRepeatedPythonStatements(fixed);
  return removeConsecutiveDuplicateLines(deduped.join("\n")).trimEnd();
}

function inferFirstPythonControlIndent(
  lines: string[],
  context: CompletionContext,
  preserveFirstLineAtCursor: boolean,
): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const trimmed = line.trimStart();
    if (!/^(if|try)\b/.test(trimmed)) {
      return null;
    }
    if (i === 0 && preserveFirstLineAtCursor) {
      return leadingWhitespace(context.cursorLinePrefix).length;
    }
    return leadingWhitespace(line).length;
  }
  return null;
}

function inferBranchIndentFromContext(
  context: CompletionContext,
  unitSize: number,
): number {
  const cursorIndent = leadingWhitespace(context.cursorLinePrefix).length;
  if (cursorIndent <= 0) {
    return 0;
  }
  return Math.max(0, cursorIndent - unitSize);
}

function removeRepeatedPythonStatements(lines: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (isPythonBranchOrBlockLine(trimmed)) {
      output.push(line);
      continue;
    }

    const key = trimmed.replace(/\s+/g, " ");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(line);
  }

  return output;
}

function isPythonBranchOrBlockLine(trimmed: string): boolean {
  return /^(if|elif|else|try|except|finally|for|while|with|def|class)\b/.test(
    trimmed,
  );
}

function isCandidateValid(
  text: string,
  context: CompletionContext,
  mode: CompletionMode,
): boolean {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = nonEmptyTrimmedLines(normalized);

  if (lines.length === 0) {
    return false;
  }
  if (mode === "inline" && normalized.length > 700) {
    return false;
  }
  if (mode === "inline" && lines.length > 8) {
    return false;
  }
  if (hasForbiddenArtifacts(normalized)) {
    return false;
  }
  if (isMostlyNaturalLanguage(normalized)) {
    return false;
  }
  if (hasLowLineDiversity(lines)) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasMergedPythonBranchKeywords(normalized)
  ) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasRepeatedPythonBranchCondition(normalized)
  ) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasInvalidPythonBranchIndent(normalized, context)
  ) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasNestedInlineImport(normalized, context, mode)
  ) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasBrokenPythonConditionalExpression(normalized)
  ) {
    return false;
  }
  if (
    context.languageId === "python" &&
    hasSuspiciousPythonNaturalLanguageLines(normalized)
  ) {
    return false;
  }
  if (hasSuspiciousStandaloneProseLines(normalized, context.languageId)) {
    return false;
  }
  if (isDuplicateOfRecentPrefix(lines, context.prefix, 10)) {
    return false;
  }

  return true;
}

function scoreCandidate(
  text: string,
  context: CompletionContext,
  mode: CompletionMode,
): number {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = nonEmptyTrimmedLines(normalized);
  let score = 1;

  if (isMostlyNaturalLanguage(normalized)) {
    score -= 0.6;
  }
  if (hasForbiddenArtifacts(normalized)) {
    score -= 0.5;
  }
  if (mode === "inline" && lines.length > 4) {
    score -= 0.2;
  }
  if (mode === "inline" && normalized.length > 320) {
    score -= 0.15;
  }
  if (isDuplicateOfRecentPrefix(lines, context.prefix, 10)) {
    score -= 0.4;
  }
  if (
    context.languageId === "python" &&
    hasRepeatedPythonBranchCondition(normalized)
  ) {
    score -= 0.5;
  }
  if (
    context.languageId === "python" &&
    hasInvalidPythonBranchIndent(normalized, context)
  ) {
    score -= 0.5;
  }
  if (
    context.languageId === "python" &&
    hasNestedInlineImport(normalized, context, mode)
  ) {
    score -= 0.6;
  }
  if (
    context.languageId === "python" &&
    hasBrokenPythonConditionalExpression(normalized)
  ) {
    score -= 0.6;
  }
  if (
    context.languageId === "python" &&
    hasSuspiciousPythonNaturalLanguageLines(normalized)
  ) {
    score -= 0.5;
  }
  if (hasSuspiciousStandaloneProseLines(normalized, context.languageId)) {
    score -= 0.5;
  }

  return clamp01(score);
}

function hasBrokenPythonConditionalExpression(text: string): boolean {
  return /\breturn\b[^\n]*\bif\b[^\n]*\n\s*else\b/.test(text);
}

function hasSuspiciousPythonNaturalLanguageLines(text: string): boolean {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (/^else\s+None\b/.test(trimmed)) {
      return true;
    }
    if (
      /^return\s+[A-Za-z_][A-Za-z0-9_]*(\s+[A-Za-z_][A-Za-z0-9_]*){2,}[.!?]?$/.test(
        trimmed,
      ) &&
      !/[()'"`[\]{}.,:+\-*/]/.test(trimmed)
    ) {
      return true;
    }
  }
  return false;
}

function hasSuspiciousStandaloneProseLines(
  text: string,
  languageId: string,
): boolean {
  const token = commentTokenForLanguage(languageId);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (token && trimmed.startsWith(token)) {
      continue;
    }
    if (looksLikeStandaloneProse(trimmed)) {
      return true;
    }
  }
  return false;
}

function looksLikeStandaloneProse(trimmed: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9,'"._-]*(\s+[A-Za-z0-9,'"._-]+)+[.!?]?$/.test(trimmed)) {
    return false;
  }
  if (/[`{}()[\];=<>:+\-*/]/.test(trimmed)) {
    return false;
  }
  if (
    /^(if|else|elif|except|finally|for|while|switch|case|return|await|throw|try|catch|const|let|var|function|class|def|import|from|new|public|private|protected|interface|type|enum)\b/.test(
      trimmed,
    )
  ) {
    return false;
  }
  return /\b(the|and|that|with|this|from|input|output|value|logic|when|for|empty|missing)\b/i.test(
    trimmed,
  );
}

function hasMergedPythonBranchKeywords(text: string): boolean {
  return /(?:\w)(?:elif|else|except|finally)\b/.test(text.replace(/\s+/g, ""));
}

function hasRepeatedPythonBranchCondition(text: string): boolean {
  const lines = text.split("\n");
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trimStart();
    const match = trimmed.match(/^(if|elif)\s+(.+):\s*$/);
    if (!match) {
      continue;
    }
    const condition = match[2].replace(/\s+/g, " ").trim();
    if (!condition) {
      continue;
    }
    if (seen.has(condition)) {
      return true;
    }
    seen.add(condition);
  }
  return false;
}

function hasInvalidPythonBranchIndent(
  text: string,
  context: CompletionContext,
): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (!first) {
    return false;
  }
  const firstTrimmed = first.trimStart();
  if (!/^(if|try)\b/.test(firstTrimmed)) {
    return false;
  }
  const firstIndent =
    context.cursorLinePrefix.trim().length === 0 &&
    context.cursorLinePrefix.length > 0
      ? leadingWhitespace(context.cursorLinePrefix).length
      : leadingWhitespace(first).length;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!/^(elif|else|except|finally)\b/.test(trimmed)) {
      continue;
    }
    const indent = leadingWhitespace(line).length;
    if (indent !== firstIndent) {
      return true;
    }
  }

  return false;
}

function hasNestedInlineImport(
  text: string,
  context: CompletionContext,
  mode: CompletionMode,
): boolean {
  if (mode !== "inline") {
    return false;
  }
  if (leadingWhitespace(context.cursorLinePrefix).length === 0) {
    return false;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^(from\s+\S+\s+import\s+\S+|import\s+\S+)/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function hasForbiddenArtifacts(text: string): boolean {
  return /```|^\s*(Here('| i)s|This code|Explanation:|Note:|Sure,|Certainly,|I can|Let's)\b/im.test(
    text,
  );
}

function isMostlyNaturalLanguage(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 8) {
    return false;
  }
  const hasCodeMarkers =
    /[{}()[\];.=<>]|=>|::|def\s+\w+|class\s+\w+|function\s+\w+/.test(text);
  if (hasCodeMarkers) {
    return false;
  }
  return /\b(the|and|that|with|this|from|your|should|could|would|because)\b/i.test(
    text,
  );
}

function hasLowLineDiversity(lines: string[]): boolean {
  if (lines.length < 3) {
    return false;
  }
  const unique = new Set(lines);
  return unique.size / lines.length < 0.55;
}

function isDuplicateOfRecentPrefix(
  candidateLines: string[],
  prefix: string,
  lookback: number,
): boolean {
  const prefixLines = nonEmptyTrimmedLines(prefix).slice(
    -Math.max(lookback, candidateLines.length),
  );
  if (prefixLines.length < candidateLines.length) {
    return false;
  }
  for (
    let start = 0;
    start <= prefixLines.length - candidateLines.length;
    start += 1
  ) {
    let matches = true;
    for (let i = 0; i < candidateLines.length; i += 1) {
      if (prefixLines[start + i] !== candidateLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
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

  const sizes = indents
    .filter((indent) => /^ +$/.test(indent))
    .map((indent) => indent.length)
    .filter((size) => size > 0);

  if (sizes.length === 0) {
    return " ".repeat(languageId === "python" ? 4 : 2);
  }

  const deltas: number[] = [];
  const uniqueSorted = [...new Set(sizes)].sort((a, b) => a - b);
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
  if (languageId === "python") {
    if (divisor > 4 || divisor === 3) {
      divisor = 4;
    }
  } else if (languageId !== "python" && divisor > 8) {
    divisor = 2;
  }

  return " ".repeat(divisor);
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

function minimumIndent(lines: string[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    minimum = Math.min(minimum, leadingWhitespace(line).length);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function stripLeadingIndent(line: string, count: number): string {
  if (!line.trim()) {
    return "";
  }
  const leading = leadingWhitespace(line);
  const remove = Math.min(count, leading.length);
  return `${leading.slice(remove)}${line.slice(leading.length)}`;
}

function clipExplanationTail(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (looksLikeExplanationLine(line)) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function looksLikeExplanationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return /^(Here('| i)s|This code|Explanation:|Note:|Sure,|Certainly,|I can|Let's)\b/i.test(
    trimmed,
  );
}

function removeConsecutiveDuplicateLines(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let previous = "";

  for (const line of lines) {
    const normalized = line.trim();
    if (normalized.length > 0 && normalized === previous) {
      continue;
    }
    if (normalized.length > 0) {
      previous = normalized;
    }
    output.push(line);
  }

  return output.join("\n");
}

function nonEmptyTrimmedLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function firstNonEmptyLine(value: string): string | null {
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      return line;
    }
  }
  return null;
}

function findLastNonEmptyLine(value: string): string | null {
  const lines = value.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      return lines[i];
    }
  }
  return null;
}

function dropLeadingEmptyLines(lines: string[]): string[] {
  let index = 0;
  while (index < lines.length && lines[index].trim().length === 0) {
    index += 1;
  }
  return lines.slice(index);
}

function leadingWhitespace(value: string): string {
  const match = value.match(/^[\t ]*/);
  return match ? match[0] : "";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
