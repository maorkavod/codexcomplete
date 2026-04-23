import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./sidebar.css";

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

interface ExtensionConfig {
  model: string;
  requestTimeoutMs: number;
  debounceMs: number;
  maxContextChars: number;
  enableInline: boolean;
  dailyTokenLimit: number | null;
}

interface UsagePoint {
  totalTokens: number;
  timestamp: string;
}

interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastTotalTokens: number;
  history: UsagePoint[];
}

interface DiagnosticsState {
  model: string;
  latencyMs: number;
  lastError: string | null;
  lastUpdated: string;
}

interface SidebarState {
  hasApiKey: boolean;
  settings: ExtensionConfig;
  diagnostics: DiagnosticsState;
  usage: UsageStats;
  modelOptions: string[];
}

type SidebarMessage =
  | { type: "setApiKey" }
  | { type: "clearApiKey" }
  | { type: "runCompleteNow" }
  | { type: "openDiagnostics" }
  | { type: "refresh" }
  | { type: "ready" }
  | { type: "saveSettings"; payload: ExtensionConfig };

type ChartPeriod = "day" | "week" | "month";

const vscode = acquireVsCodeApi();

const emptyState: SidebarState = {
  hasApiKey: false,
  settings: {
    model: "gpt-5.3-codex",
    requestTimeoutMs: 15000,
    debounceMs: 120,
    maxContextChars: 6000,
    enableInline: true,
    dailyTokenLimit: null
  },
  diagnostics: {
    model: "-",
    latencyMs: 0,
    lastError: null,
    lastUpdated: "-"
  },
  usage: {
    totalRequests: 0,
    totalTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastTotalTokens: 0,
    history: []
  },
  modelOptions: ["gpt-5.3-codex"]
};

function App(): React.JSX.Element {
  const [state, setState] = useState<SidebarState>(emptyState);
  const [draft, setDraft] = useState<ExtensionConfig>(emptyState.settings);
  const [period, setPeriod] = useState<ChartPeriod>("week");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== "state") {
        return;
      }

      const nextState = message.payload as SidebarState;
      setState(nextState);
      setDraft(nextState.settings);
    };

    window.addEventListener("message", onMessage);
    post({ type: "ready" });

    return () => window.removeEventListener("message", onMessage);
  }, []);

  const tokenSeries = useMemo(() => buildSeries(state.usage.history, period, "tokens"), [state.usage.history, period]);
  const requestSeries = useMemo(() => buildSeries(state.usage.history, period, "requests"), [state.usage.history, period]);

  const modelOptions = useMemo(() => {
    const deduped = new Set(state.modelOptions);
    deduped.add(draft.model);
    return [...deduped].sort((a, b) => a.localeCompare(b));
  }, [state.modelOptions, draft.model]);

  return (
    <div className="cc-shell">
      <aside className="cc-nav" aria-hidden="true">
        <button className="cc-icon-btn cc-icon-muted">R</button>
        <button className="cc-icon-btn cc-icon-muted">S</button>
        <button className="cc-icon-btn cc-icon-active">CC</button>
        <button className="cc-icon-btn cc-icon-muted">D</button>
      </aside>

      <main className="cc-main">
        <header className="cc-header">
          <div>
            <p className="cc-brand">CODEXCOMPLETE</p>
          </div>
          <button className="cc-menu" onClick={() => post({ type: "refresh" })} title="Refresh">
            ...
          </button>
        </header>

        <section className="cc-card">
          <label className="cc-label" htmlFor="model">
            Model
          </label>
          <div className="cc-select-wrap">
            <span className="cc-dot" />
            <select
              id="model"
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            >
              {modelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <p className="cc-muted">Auto-loaded from your OpenAI account</p>
          <div className="cc-inline-actions">
            <button className="cc-secondary" onClick={() => post({ type: "setApiKey" })}>
              Set Key
            </button>
            <button className="cc-secondary" onClick={() => post({ type: "clearApiKey" })}>
              Clear Key
            </button>
            <span className={state.hasApiKey ? "cc-pill ok" : "cc-pill warn"}>{state.hasApiKey ? "Connected" : "No Key"}</span>
          </div>
        </section>

        <section className="cc-card">
          <h2>Settings</h2>
          <div className="cc-grid">
            <label>
              <span>Request Timeout (ms)</span>
              <input
                type="number"
                value={draft.requestTimeoutMs}
                onChange={(event) => updateNumber(event.target.value, "requestTimeoutMs", setDraft)}
              />
            </label>
            <label>
              <span>Debounce (ms)</span>
              <input type="number" value={draft.debounceMs} onChange={(event) => updateNumber(event.target.value, "debounceMs", setDraft)} />
            </label>
            <label>
              <span>Max Context (chars)</span>
              <input
                type="number"
                value={draft.maxContextChars}
                onChange={(event) => updateNumber(event.target.value, "maxContextChars", setDraft)}
              />
            </label>
            <label>
              <span>Daily Token Limit</span>
              <input
                type="number"
                value={draft.dailyTokenLimit ?? ""}
                placeholder="No limit"
                onChange={(event) => {
                  const next = event.target.value.trim();
                  setDraft((current) => ({
                    ...current,
                    dailyTokenLimit: next === "" ? null : Number(next)
                  }));
                }}
              />
            </label>
            <div className="cc-toggle-row">
              <span>Enable Inline</span>
              <button
                className={draft.enableInline ? "cc-toggle on" : "cc-toggle"}
                type="button"
                onClick={() => setDraft((current) => ({ ...current, enableInline: !current.enableInline }))}
                aria-pressed={draft.enableInline}
              >
                <span />
              </button>
            </div>
          </div>

          <div className="cc-actions">
            <button className="cc-primary" onClick={() => post({ type: "saveSettings", payload: draft })}>
              Save Settings
            </button>
            <button className="cc-secondary" onClick={() => post({ type: "runCompleteNow" })}>
              Complete Now
            </button>
          </div>
        </section>

        <section className="cc-card">
          <div className="cc-card-head">
            <h2>Diagnostics</h2>
            <select value={period} onChange={(event) => setPeriod(event.target.value as ChartPeriod)}>
              <option value="day">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
            </select>
          </div>

          <div className="cc-metric-card">
            <p>Total Tokens</p>
            <strong>{formatNumber(sumSeries(tokenSeries))}</strong>
            <small>Last req: {formatNumber(state.usage.lastTotalTokens)}</small>
            <BarChart points={tokenSeries} />
          </div>

          <div className="cc-metric-card">
            <p>Total Requests</p>
            <strong>{formatNumber(sumSeries(requestSeries))}</strong>
            <small>{state.diagnostics.lastError ? `Error: ${state.diagnostics.lastError}` : "No errors"}</small>
            <LineChart points={requestSeries} />
          </div>

          <div className="cc-footer-row">
            <span>Latency: {state.diagnostics.latencyMs} ms</span>
            <span>{state.diagnostics.lastUpdated}</span>
          </div>

          <div className="cc-actions">
            <button className="cc-secondary" onClick={() => post({ type: "openDiagnostics" })}>
              Open Full Diagnostics
            </button>
            <button className="cc-secondary" onClick={() => post({ type: "refresh" })}>
              Refresh
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function post(message: SidebarMessage): void {
  vscode.postMessage(message);
}

function updateNumber(
  value: string,
  key: "requestTimeoutMs" | "debounceMs" | "maxContextChars",
  setDraft: React.Dispatch<React.SetStateAction<ExtensionConfig>>
): void {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return;
  }
  setDraft((current) => ({ ...current, [key]: next }));
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

interface SeriesPoint {
  label: string;
  value: number;
}

function sumSeries(points: SeriesPoint[]): number {
  return points.reduce((sum, point) => sum + point.value, 0);
}

function buildSeries(history: UsagePoint[], period: ChartPeriod, mode: "tokens" | "requests"): SeriesPoint[] {
  const ranges = rangeKeys(period);
  const totals = new Map<string, number>();

  for (const point of history ?? []) {
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const key = keyForDate(date, period);
    const current = totals.get(key) ?? 0;
    const increment = mode === "tokens" ? Math.max(0, Math.floor(point.totalTokens)) : 1;
    totals.set(key, current + increment);
  }

  return ranges.map((range) => ({
    label: labelForKey(range, period),
    value: totals.get(range) ?? 0
  }));
}

function rangeKeys(period: ChartPeriod): string[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const count = period === "day" ? 7 : period === "week" ? 7 : 6;
  const list: string[] = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(now);

    if (period === "month") {
      date.setDate(1);
      date.setMonth(now.getMonth() - i);
    } else {
      date.setDate(now.getDate() - i);
    }

    list.push(keyForDate(date, period));
  }

  return list;
}

function keyForDate(date: Date, period: ChartPeriod): string {
  if (period === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function labelForKey(key: string, period: ChartPeriod): string {
  if (period === "month") {
    const [year, month] = key.split("-");
    return `${month}/${year.slice(2)}`;
  }

  const date = new Date(`${key}T00:00:00`);
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

function BarChart({ points }: { points: SeriesPoint[] }): React.JSX.Element {
  const max = Math.max(1, ...points.map((point) => point.value));

  return (
    <div className="cc-chart">
      <div className="cc-bars">
        {points.map((point, index) => (
          <div key={`${point.label}-${index}`} className="cc-bar-wrap" title={`${point.label}: ${formatNumber(point.value)}`}>
            <div className="cc-bar" style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="cc-axis-labels">
        {points.map((point, index) => (
          <span key={`${point.label}-${index}`}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}

function LineChart({ points }: { points: SeriesPoint[] }): React.JSX.Element {
  const max = Math.max(1, ...points.map((point) => point.value));
  const width = 100;
  const height = 44;
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const polyline = points
    .map((point, index) => {
      const x = step * index;
      const y = height - (point.value / max) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="cc-line-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={polyline} fill="none" className="cc-line" />
      </svg>
      <div className="cc-axis-labels">
        {points.map((point, index) => (
          <span key={`${point.label}-${index}`}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}

const rootNode = document.getElementById("root");

if (rootNode) {
  createRoot(rootNode).render(<App />);
}
