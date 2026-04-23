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

    const prefixBudget = Math.floor(maxContextChars * 0.75);
    const suffixBudget = maxContextChars - prefixBudget;

    const prefixStart = Math.max(0, offset - prefixBudget);
    const suffixEnd = Math.min(fullText.length, offset + suffixBudget);

    const prefix = fullText.slice(prefixStart, offset);
    const suffix = fullText.slice(offset, suffixEnd);

    return {
      languageId: document.languageId,
      fileName: document.fileName,
      prefix,
      suffix,
      selectedText
    };
  }
}
