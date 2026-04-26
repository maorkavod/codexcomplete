import * as vscode from "vscode";
import { API_KEY_SECRET, getConfig } from "./config";
import { ContextCollector } from "./contextCollector";
import { OpenAIClient } from "./openaiClient";
import { CompletionEngine } from "./completionEngine";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { SidebarViewProvider } from "./sidebarViewProvider";
import { EditorIndentation, UsageStats } from "./types";
import { Logger } from "./logger";

const USAGE_STATS_KEY = "codexComplete.usageStats";
const INLINE_SELECTOR: vscode.DocumentSelector = [{ scheme: "file" }, { scheme: "untitled" }];

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger("CodexComplete");
  context.subscriptions.push(logger);
  logger.info("Extension activation started.");

  const panel = new DiagnosticsPanel();
  const engine = new CompletionEngine({
    client: new OpenAIClient(logger),
    collector: new ContextCollector(),
    getConfig,
    getApiKey: async () => context.secrets.get(API_KEY_SECRET),
    diagnosticsPanel: panel,
    initialUsageStats: context.globalState.get<UsageStats>(USAGE_STATS_KEY),
    saveUsageStats: async (stats) => context.globalState.update(USAGE_STATS_KEY, stats),
    logger
  });
  const sidebarProvider = new SidebarViewProvider(context, panel, engine, logger);

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
  logger.info("Sidebar view provider registered.");

  const inlineProvider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _context, token) {
      logger.debug(
        `Inline trigger: mode=inline language=${document.languageId} scheme=${document.uri.scheme}`
      );
      const editorOptions = resolveEditorIndentationForDocument(document);
      const result = await engine.complete({
        document,
        position,
        mode: "inline",
        token,
        editorOptions
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
    vscode.languages.registerInlineCompletionItemProvider(INLINE_SELECTOR, inlineProvider)
  );
  logger.info("Inline completion provider registered for file/untitled documents.");

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.setApiKey", async () => {
      logger.info("Command invoked: setApiKey");
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your OpenAI API key",
        ignoreFocusOut: true,
        password: true,
        placeHolder: "sk-..."
      });

      if (!apiKey) {
        logger.warn("setApiKey canceled by user.");
        vscode.window.showWarningMessage("CodexComplete: API key was not saved.");
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey.trim());
      logger.info("API key stored in VS Code secret storage.");
      vscode.window.showInformationMessage("CodexComplete: API key saved securely.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.completeNow", async () => {
      logger.info("Command invoked: completeNow");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logger.warn("completeNow ignored: no active editor.");
        vscode.window.showWarningMessage("CodexComplete: No active editor.");
        return;
      }

      const selection = editor.selection;
      const selectedText = selection.isEmpty
        ? undefined
        : editor.document.getText(new vscode.Range(selection.start, selection.end));

      const tokenSource = new vscode.CancellationTokenSource();
      const editorOptions: EditorIndentation = {
        insertSpaces: editor.options.insertSpaces === false ? false : true,
        tabSize: typeof editor.options.tabSize === "number" ? editor.options.tabSize : undefined
      };
      const result = await (async () => {
        try {
          return await engine.complete({
            document: editor.document,
            position: selection.active,
            selectedText,
            mode: "manual",
            token: tokenSource.token,
            editorOptions
          });
        } finally {
          tokenSource.dispose();
        }
      })();

      if (!result.text) {
        if (result.diagnostics.lastError && result.diagnostics.lastError !== "Request canceled") {
          logger.warn(`completeNow returned no text: ${result.diagnostics.lastError}`);
          vscode.window.showWarningMessage(`CodexComplete: ${result.diagnostics.lastError}`);
        }
        return;
      }

      await editor.edit((editBuilder) => {
        editBuilder.insert(selection.active, result.text ?? "");
      });
      logger.info("completeNow inserted completion text into the active editor.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.openPanel", () => {
      logger.info("Command invoked: openPanel");
      panel.show(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.openLogs", () => {
      logger.info("Command invoked: openLogs");
      logger.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexComplete.openLogsTerminal", () => {
      logger.info("Command invoked: openLogsTerminal");
      logger.showTerminal(true);
    })
  );

  logger.info("Extension activation completed.");
}

export function deactivate(): void {
  // No cleanup required for the POC.
}

function resolveEditorIndentationForDocument(document: vscode.TextDocument): EditorIndentation | undefined {
  const editor = vscode.window.visibleTextEditors.find(
    (item) => item.document.uri.toString() === document.uri.toString()
  );
  if (!editor) {
    return undefined;
  }
  return {
    insertSpaces: editor.options.insertSpaces === false ? false : true,
    tabSize: typeof editor.options.tabSize === "number" ? editor.options.tabSize : undefined
  };
}
