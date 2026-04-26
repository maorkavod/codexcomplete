import * as vscode from "vscode";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const REDACTED = "[REDACTED]";
const REDACTION_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [
    /(\bauthorization\b\s*[:=]\s*["']?\s*bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi,
    (_match, prefix) => `${prefix}${REDACTED}`
  ],
  [/\bBearer\s+([A-Za-z0-9\-._~+/]+=*)/g, () => `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, () => REDACTED],
  [
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|token)\b(\s*[:=]\s*["']?)([^"',\s}{\]]{4,})/gi,
    (_match, separator) => `${separator}${REDACTED}`
  ],
  [
    /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)=)([^&\s]+)/gi,
    (_match, prefix) => `${prefix}${REDACTED}`
  ]
];

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
    const line = `[${new Date().toISOString()}] [${level}] ${redactSensitiveText(message)}`;
    this.output.appendLine(line);
    this.terminalEmitter.fire(`${line}\r\n`);
  }
}

function redactSensitiveText(text: string): string {
  if (!mayContainSensitiveContent(text)) {
    return text;
  }

  let redacted = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function mayContainSensitiveContent(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("bearer ") ||
    lower.includes("authorization") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("sk-")
  );
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
