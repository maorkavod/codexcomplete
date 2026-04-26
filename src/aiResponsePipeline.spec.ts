import { test } from "node:test";
import assert from "node:assert/strict";
import { processAIResponseCandidate } from "./aiResponsePipeline";
import { CompletionContext } from "./types";

function makeContext(overrides: Partial<CompletionContext>): CompletionContext {
  return {
    languageId: "python",
    fileName: "quota.py",
    prefix: "",
    suffix: "",
    cursorLinePrefix: "",
    cursorLineSuffix: "",
    recentContext: "",
    upcomingContext: "",
    ...overrides
  };
}

test("python: keeps first line at cursor and normalizes multiline indentation", () => {
  const context = makeContext({
    prefix:
      "async def process_quota(target_user, quota_pct, remaining):\n" +
      "    if target_user.whatsapp_id:\n" +
      "            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n            await session.commit()\n",
  });

  const raw =
    "if quota_pct < QUOTA_WARNING_THRESHOLD:\n" +
    "                target_user.quota_warning_sent = Falseelif quota_pct >= 1.0:\n" +
    "    target_user.quota_warning_sent = True";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.equal(
    result.text.split("\n")[0],
    "if quota_pct < QUOTA_WARNING_THRESHOLD:",
    "line 1 should be anchored at cursor position without extra indent"
  );
  assert.match(
    result.text,
    /\n\s{16}target_user\.quota_warning_sent = False/,
    "line 2 should be inside the block (16 spaces)"
  );
  assert.match(
    result.text,
    /\n\s{12}elif quota_pct >= 1\.0:/,
    "elif should be branch-aligned to baseline"
  );
});

test("python: mid-line cursor after block opener starts completion on next line", () => {
  const context = makeContext({
    prefix:
      "async def process_quota(target_user, quota_pct):\n" +
      "    if target_user.whatsapp_id:\n" +
      "            if quota_pct < QUOTA_WARNING_THRESHOLD:",
    cursorLinePrefix: "            if quota_pct < QUOTA_WARNING_THRESHOLD:",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw = "target_user.quota_warning_sent = False";
  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.equal(
    result.text,
    "\n                target_user.quota_warning_sent = False",
    "completion should start on a new indented line after ':'"
  );
});

test("python: rejects repeated if/elif condition", () => {
  const context = makeContext({
    prefix:
      "async def process_quota(target_user, quota_pct):\n" +
      "    if target_user.whatsapp_id:\n" +
      "            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "if quota_pct < QUOTA_WARNING_THRESHOLD:\n" +
    "    target_user.quota_warning_sent = False\n" +
    "elif quota_pct < QUOTA_WARNING_THRESHOLD:\n" +
    "    target_user.quota_warning_sent = False";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.equal(result, null, "duplicate if/elif condition should be dropped");
});

test("python: fixes misindented branch to align with first control line", () => {
  const context = makeContext({
    prefix:
      "async def process_quota(target_user, quota_pct):\n" +
      "    if target_user.whatsapp_id:\n" +
      "            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "if quota_pct < QUOTA_WARNING_THRESHOLD:\n" +
    "    target_user.quota_warning_sent = False\n" +
    "    elif quota_pct >= 1.0:\n" +
    "        target_user.quota_warning_sent = True";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /\n\s{12}elif quota_pct >= 1\.0:/,
    "branch line should be aligned to the first control line depth"
  );
});

test("python: splits merged call and keeps body indentation after control line", () => {
  const context = makeContext({
    prefix:
      "async def process_quota(target_user):\n" +
      "    if target_user.whatsapp_id:\n" +
      "                ",
    cursorLinePrefix: "                ",
    cursorLineSuffix: "",
    suffix: "\n                await session.commit()\n",
  });

  const raw =
    "if target_user.is_over_quota():\n" +
    "    logger.warning(f\"⚠️ Quota exceeded after response | Business: {target_user.whatsapp_id}\")send_whatsapp(\n" +
    "target_user.whatsapp_id,\n" +
    "f\"🚫 *המכסה נוצלה במלואה*\\n{target_user.display_name} הגיע למכסת ההודעות החודשית.\",\n" +
    ")";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /\)\n\s{20}send_whatsapp\(/,
    "merged call should be split into a new properly indented line"
  );
  assert.match(
    result.text,
    /\n\s{20}target_user\.whatsapp_id,/,
    "arguments should stay in control-body indentation"
  );
});

test("python: removes duplicated side-effect statements in candidate body", () => {
  const context = makeContext({
    prefix:
      "async def update_activity(target_user, session):\n" +
      "    if target_user.whatsapp_id:\n" +
      "                ",
    cursorLinePrefix: "                ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "await session.flush()\n" +
    "\n" +
    "target_user.last_activity_at = datetime.now(timezone.utc)\n" +
    "await session.flush()";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  const flushCount = (result.text.match(/await session\.flush\(\)/g) ?? []).length;
  assert.equal(flushCount, 1, "duplicate await session.flush() should be removed");
});

test("python: enforces body indentation after inline if control line", () => {
  const context = makeContext({
    prefix:
      "async def update_customer(customer, session, previous_last_contact):\n" +
      "    if customer:\n" +
      "            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "await session.flush()\n" +
    "if previous_last_contact and (datetime.now(timezone.utc) - ensure_utc(previous_last_contact)) > timedelta(hours=24):\n" +
    "customer.total_conversations = 1";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /\n\s{16}customer\.total_conversations = 1/,
    "line after control ':' should be indented one level deeper"
  );
});

test("python: rejects inline nested import inside indented block completions", () => {
  const context = makeContext({
    prefix:
      "async def update_customer(target_user):\n" +
      "    if target_user.is_over_quota():\n" +
      "                ",
    cursorLinePrefix: "                ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "from app.services import send_whatsapp\n" +
    "send_whatsapp(target_user.whatsapp_id)";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.equal(result, null, "nested inline imports should be dropped in block-level completions");
});

test("python: cursor at end of statement forces newline before continuation", () => {
  const context = makeContext({
    prefix:
      "async def mark_quota(target_user, session):\n" +
      "    if quota_pct >= QUOTA_WARNING_THRESHOLD and not target_user.quota_warning_sent:\n" +
      "                await session.flush()",
    cursorLinePrefix: "                await session.flush()",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw = "else:\nawait session.flush()";
  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /^\n\s{12}else:/,
    "continuation should start on a new line, not append to flush()"
  );
});

test("python: cursor after if block line keeps awaited call inside block", () => {
  const context = makeContext({
    prefix:
      "async def notify_quota(target_user):\n" +
      "            if target_user.is_over_quota():",
    cursorLinePrefix: "            if target_user.is_over_quota():",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "await send_whatsapp(\n" +
    "target_user.whatsapp_id,\n" +
    "f\"🚫 *המכסה נוצלה במלואה*\\n{target_user.display_name} הגיע למכסת ההודעות החודשית.\",\n" +
    ")";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.match(result.text, /^\n\s{16}await send_whatsapp\(/, "await should be inside if body");
  assert.match(
    result.text,
    /\n\s{16}target_user\.whatsapp_id,/,
    "call arguments should remain inside the same block depth"
  );
});

test("python: requires first line comment when option is enabled", () => {
  const context = makeContext({
    prefix: "async def notify_quota(target_user):\n            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw = "await send_whatsapp(target_user.whatsapp_id)";
  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: true
  });
  assert.equal(result, null, "candidate without leading comment should be rejected");
});

test("python: allows non-comment first line when option is disabled", () => {
  const context = makeContext({
    prefix: "async def notify_quota(target_user):\n            ",
    cursorLinePrefix: "            ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw = "await send_whatsapp(target_user.whatsapp_id)";
  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: false
  });
  assert.ok(result, "candidate should be allowed when comment option is off");
});

test("python: fixes wrapped leading comment continuation when comment option is enabled", () => {
  const context = makeContext({
    languageId: "python",
    fileName: "quota.py",
    prefix: "def _upper(v: Any) -> Optional[str]:\n    ",
    cursorLinePrefix: "    ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "# Normalize any value to uppercase text, returning None\n" +
    "for missing input.\n" +
    "if v is None:\n" +
    "  return None\n" +
    "return str(v).strip().upper() or None";

  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: true
  });
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /^# Normalize any value to uppercase text, returning None\n\s*# for missing input\./,
    "wrapped prose line should be converted into a comment line"
  );
});

test("javascript: fixes wrapped leading comment continuation when comment option is enabled", () => {
  const context = makeContext({
    languageId: "javascript",
    fileName: "utils.js",
    prefix: "const upper = (v) => {\n  ",
    cursorLinePrefix: "  ",
    cursorLineSuffix: "",
    suffix: "\n};\n",
  });

  const raw =
    "// Normalize any value to uppercase text, returning null\n" +
    "for missing input.\n" +
    "if (v == null) {\n" +
    "  return null;\n" +
    "}\n" +
    "return String(v).trim().toUpperCase() || null;";

  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: true
  });
  assert.ok(result, "candidate should survive processing");
  assert.match(
    result.text,
    /^\/\/ Normalize any value to uppercase text, returning null\n\s*\/\/ for missing input\./,
    "wrapped prose line should be converted into a JS comment line"
  );
});

test("javascript: does not convert actual code line after leading comment", () => {
  const context = makeContext({
    languageId: "javascript",
    fileName: "utils.js",
    prefix: "const upper = (v) => {\n  ",
    cursorLinePrefix: "  ",
    cursorLineSuffix: "",
    suffix: "\n};\n",
  });

  const raw =
    "// Normalize the value\n" +
    "if (v == null) {\n" +
    "  return null;\n" +
    "}";

  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: true
  });
  assert.ok(result, "candidate should survive processing");
  assert.match(result.text, /\n\s*if \(v == null\) \{/, "code line should remain code");
});

test("python: rejects malformed mixed prose and broken conditional expression", () => {
  const context = makeContext({
    languageId: "python",
    fileName: "quota.py",
    prefix: "def _upper(v: Any) -> Optional[str]:\n    ",
    cursorLinePrefix: "    ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "# Normalize any value to an uppercase string, returning None\n" +
    "# for empty input.\n" +
    "s = _safe(v).strip()\n" +
    "return s.upper() if s\n" +
    "else None\n" +
    "# Return None when normalization yields an empty string.\n" +
    "# Use a conditional expression to\n" +
    "return uppercase text or None\n" +
    "for empty input.\n" +
    "return s.upper() if s\n" +
    "else None\n" +
    "# Return None when normalization yields an empty string.\n" +
    "else None";

  const result = processAIResponseCandidate(raw, context, "inline", {
    requireLeadingLogicComment: true
  });
  assert.equal(result, null, "malformed mixed prose/code candidate should be rejected");
});

test("python: normalizes mixed tabs/spaces into stable branch indentation", () => {
  const context = makeContext({
    languageId: "python",
    fileName: "quota.py",
    prefix: "def should_notify(target_user):\n    ",
    cursorLinePrefix: "    ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw =
    "if target_user.is_over_quota():\n" +
    "\treturn True\n" +
    "\telif target_user.is_warned:\n" +
    "    \treturn False";

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.ok(result, "candidate should survive processing");
  assert.ok(
    !result.text.includes("\t"),
    "pipeline should normalize indentation and avoid raw tab indentation artifacts"
  );
  assert.match(
    result.text,
    /\n\s{4}elif target_user\.is_warned:/,
    "branch keyword should remain aligned with the first control line"
  );
});

test("inline limits: rejects candidates over inline line budget", () => {
  const context = makeContext({
    languageId: "python",
    fileName: "budget.py",
    prefix: "def budget_guard():\n    ",
    cursorLinePrefix: "    ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const raw = [
    "v1 = 1",
    "v2 = 2",
    "v3 = 3",
    "v4 = 4",
    "v5 = 5",
    "v6 = 6",
    "v7 = 7",
    "v8 = 8",
    "v9 = 9",
  ].join("\n");

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.equal(result, null, "inline candidate with more than eight lines should be rejected");
});

test("inline limits: rejects candidates over inline character budget", () => {
  const context = makeContext({
    languageId: "python",
    fileName: "budget.py",
    prefix: "def budget_guard():\n    ",
    cursorLinePrefix: "    ",
    cursorLineSuffix: "",
    suffix: "\n",
  });

  const longIdentifier = "very_long_signal_name_".repeat(40);
  const raw = `value = "${longIdentifier}"`;
  assert.ok(raw.length > 700, "fixture should exceed inline character limit");

  const result = processAIResponseCandidate(raw, context, "inline");
  assert.equal(result, null, "inline candidate over character limit should be rejected");
});
