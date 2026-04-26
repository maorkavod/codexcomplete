import * as vscode from "vscode";
import { CompletionContext } from "./types";

export class ContextCollector {
  collect(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxContextChars: number,
    selectedText?: string
  ): CompletionContext {
    const fullText = document.getText();
    const offset = document.offsetAt(position);

    const prefixBudget = Math.floor(maxContextChars * 0.82);
    const suffixBudget = maxContextChars - prefixBudget;

    const prefixStart = Math.max(0, offset - prefixBudget);
    const suffixEnd = Math.min(fullText.length, offset + suffixBudget);

    const prefix = fullText.slice(prefixStart, offset);
    const suffix = fullText.slice(offset, suffixEnd);
    const currentLine = document.lineAt(position.line).text;
    const cursorLinePrefix = currentLine.slice(0, position.character);
    const cursorLineSuffix = currentLine.slice(position.character);

    return {
      languageId: document.languageId,
      fileName: document.fileName,
      prefix,
      suffix,
      cursorLinePrefix,
      cursorLineSuffix,
      recentContext: collectRecentContext(prefix),
      upcomingContext: collectUpcomingContext(suffix),
      selectedText
    };
  }
}

function collectRecentContext(prefix: string): string {
  const lines = prefix.replace(/\r\n?/g, "\n").split("\n");
  const withoutCurrentLine = lines.slice(0, -1);
  const picked: string[] = [];
  let chars = 0;

  for (let i = withoutCurrentLine.length - 1; i >= 0; i -= 1) {
    const line = withoutCurrentLine[i];
    if (picked.length >= 24 || chars + line.length > 1800) {
      break;
    }
    picked.unshift(line);
    chars += line.length;
  }

  return picked.join("\n");
}

function collectUpcomingContext(suffix: string): string {
  const lines = suffix.replace(/\r\n?/g, "\n").split("\n");
  const withoutCurrentLine = lines.slice(1);
  const picked: string[] = [];
  let chars = 0;

  for (const line of withoutCurrentLine) {
    if (picked.length >= 24 || chars + line.length > 1800) {
      break;
    }
    picked.push(line);
    chars += line.length;
  }

  return picked.join("\n");
}
