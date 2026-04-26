import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInsertionText } from "./insertionFormatter";
import { CompletionContext } from "./types";

function makeContext(overrides: Partial<CompletionContext>): CompletionContext {
  return {
    languageId: "python",
    fileName: "sample.py",
    prefix: "",
    suffix: "",
    cursorLinePrefix: "",
    cursorLineSuffix: "",
    recentContext: "",
    upcomingContext: "",
    insertSpaces: true,
    tabSize: 4,
    detectedIndentUnit: "    ",
    ...overrides
  };
}

test("insertion formatter: python keeps 4-space body indentation in smart mode", () => {
  const context = makeContext({
    languageId: "python",
    cursorLinePrefix: "            ",
    insertSpaces: true,
    tabSize: 4,
    detectedIndentUnit: "    "
  });

  const result = formatInsertionText(
    "if quota_pct >= 1.0:\n                target_user.quota_warning_sent = True\n            elif quota_pct < 0.8:\n                target_user.quota_warning_sent = False",
    context,
    { mode: "inline", indentMode: "smart" }
  );

  assert.ok(result.text);
  assert.equal(
    result.text,
    "if quota_pct >= 1.0:\n                target_user.quota_warning_sent = True\n            elif quota_pct < 0.8:\n                target_user.quota_warning_sent = False"
  );
});

test("insertion formatter: editor mode converts leading spaces to tabs when insertSpaces=false", () => {
  const context = makeContext({
    languageId: "javascript",
    fileName: "sample.js",
    insertSpaces: false,
    tabSize: 2,
    detectedIndentUnit: "  "
  });

  const result = formatInsertionText(
    "if (ready) {\n  return result;\n}",
    context,
    { mode: "inline", indentMode: "editor" }
  );

  assert.ok(result.text);
  assert.equal(result.text, "if (ready) {\n\treturn result;\n}");
  assert.equal(result.corrected, true);
});

test("insertion formatter: language mode keeps yaml spaces", () => {
  const context = makeContext({
    languageId: "yaml",
    fileName: "workflow.yaml",
    insertSpaces: true,
    tabSize: 2,
    detectedIndentUnit: "  "
  });

  const result = formatInsertionText(
    "- name: lint\n    run: npm run lint",
    context,
    { mode: "inline", indentMode: "language" }
  );

  assert.ok(result.text);
  assert.equal(result.text, "- name: lint\n    run: npm run lint");
});
