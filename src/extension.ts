import * as vscode from "vscode";
import { API_KEY_SECRET, getConfig } from "./config";
import { ContextCollector } from "./contextCollector";
import { OpenAIClient } from "./openaiClient";
import { CompletionEngine } from "./completionEngine";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { SidebarViewProvider } from "./sidebarViewProvider";
import { UsageStats } from "./types";

const SUPPORTED_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "csharp",
  "plaintext"
];
const USAGE_STATS_KEY = "codexComplete.usageStats";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new DiagnosticsPanel();
  const engine = new CompletionEngine({
    client: new OpenAIClient(),
    collector: new ContextCollector(),
    getConfig,
    getApiKey: async () => context.secrets.get(API_KEY_SECRET),
    diagnosticsPanel: panel,
    initialUsageStats: context.globalState.get<UsageStats>(USAGE_STATS_KEY),
    saveUsageStats: async (stats) => context.globalState.update(USAGE_STATS_KEY, stats)
  });
  const sidebarProvider = new SidebarViewProvider(context, panel, engine);

  panel.update({
    model: getConfig().model,
    latencyMs: 0,
    lastError: null,
    lastUpdated: new Date().toISOString(),
    usage: engine.getUsageStats()
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexComplete.sidebarView", sidebarProvider)
  );

  const inlineProvider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _context, token) {
      const result = await engine.complete({
        document,
        position,
        mode: "inline",
        token
      });

      if (!result.text) {
        return { items: [] };
      }

      return {
        items: [
          {
            insertText: result.text,
            range: new vscode.Range(position, position)
          }
        ]
      };
    }
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      SUPPORTED_LANGUAGES.map((language) => ({ language })),
      inlineProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.setApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your OpenAI API key",
        ignoreFocusOut: true,
        password: true,
        placeHolder: "sk-..."
      });

      if (!apiKey) {
        vscode.window.showWarningMessage("CodexComplete: API key was not saved.");
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey.trim());
      vscode.window.showInformationMessage("CodexComplete: API key saved securely.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.completeNow", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("CodexComplete: No active editor.");
        return;
      }

      const selection = editor.selection;
      const selectedText = selection.isEmpty
        ? undefined
        : editor.document.getText(new vscode.Range(selection.start, selection.end));

      const tokenSource = new vscode.CancellationTokenSource();
      const result = await (async () => {
        try {
          return await engine.complete({
            document: editor.document,
            position: selection.active,
            selectedText,
            mode: "manual",
            token: tokenSource.token
          });
        } finally {
          tokenSource.dispose();
        }
      })();

      if (!result.text) {
        if (result.diagnostics.lastError && result.diagnostics.lastError !== "Request canceled") {
          vscode.window.showWarningMessage(`CodexComplete: ${result.diagnostics.lastError}`);
        }
        return;
      }

      await editor.edit((editBuilder) => {
        editBuilder.insert(selection.active, result.text ?? "");
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.openPanel", () => {
      panel.show(context);
    })
  );
}

export function deactivate(): void {
  // No cleanup required for the POC.
}
