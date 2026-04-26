import * as vscode from "vscode";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export class Logger implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly terminalEmitter = new vscode.EventEmitter<string>();
  private readonly terminal: vscode.Terminal;

  constructor(channelName: string) {
    this.output = vscode.window.createOutputChannel(channelName);
    this.terminal = vscode.window.createTerminal({
      name: `${channelName} Logs`,
      pty: {
        onDidWrite: this.terminalEmitter.event,
        open: () => {
          this.terminalEmitter.fire("CodexComplete logs are streaming here.\r\n");
        },
        close: () => undefined
      },
      isTransient: true
    });
  }

  info(message: string): void {
    this.log("INFO", message);
  }

  warn(message: string): void {
    this.log("WARN", message);
  }

  error(message: string, error?: unknown): void {
    const suffix = error ? ` | ${toErrorMessage(error)}` : "";
    this.log("ERROR", `${message}${suffix}`);
  }

  debug(message: string): void {
    this.log("DEBUG", message);
  }

  show(preserveFocus = false): void {
    this.output.show(preserveFocus);
  }

  showTerminal(preserveFocus = false): void {
    this.terminal.show(preserveFocus);
  }

  dispose(): void {
    this.terminal.dispose();
    this.terminalEmitter.dispose();
    this.output.dispose();
  }

  private log(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    this.output.appendLine(line);
    this.terminalEmitter.fire(`${line}\r\n`);
  }
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}
