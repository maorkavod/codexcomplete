# Changelog

All notable changes to this project will be documented in this file.

## [0.0.15] - 2026-04-26

- Refactored completion flow to use a shared insertion formatter for both inline Tab-accept and manual `Complete Now`, improving indentation consistency across languages (with Python-first behavior).
- Added editor-aware indentation context (`insertSpaces`, `tabSize`, detected unit) and new insertion strategy setting `codexComplete.indentMode` (`editor` | `language` | `smart`).
- Added inline safety controls `codexComplete.inlineMaxLines`, `codexComplete.inlineMaxChars`, and `codexComplete.strictInlineMode`.
- Changed `codexComplete.includeLeadingLogicComment` default to `false` for cleaner inline insertions.
- Hardened prompt/pipeline behavior for strict inline mode and expanded filtering/scoring controls.
- Added OpenAI resilience controls: transient retry with jitter, short cooldown after repeated transient failures, and richer debug reasons.
- Added graceful fallback when inline candidates are filtered out (`no_valid_candidates`), using a bounded/sanitized raw candidate instead of returning empty suggestions.
- Added in-flight request dedupe for identical completion requests.
- Added usage diagnostics counters (`suggestionsShown`, `nullResponses`, `timeoutResponses`, `indentCorrections`) and surfaced them in the sidebar.
- Improved sidebar settings UX and added controls for new completion settings.
- Added security hardening for log redaction (API keys/tokens/secrets) and optional raw response text support in HTTP client error handling.
- Expanded tests with mixed indentation and insertion formatter golden cases; pipeline suite now includes formatter tests.
- Added delivery artifacts: `TASK_MATRIX.md` and `INTEGRATION_SUMMARY.md`.

## [0.0.13] - 2026-04-26

- Added a new setting `codexComplete.includeLeadingLogicComment` (default: `true`) to require a first-line logic comment in completions.
- Added the new sidebar settings toggle **Add Comments** and wired persistence through webview state and extension settings save flow.
- Expanded context collection and prompt structure with explicit top/bottom buffers and cursor-aware indentation hints.
- Reworked AI response post-processing into a deterministic pipeline with stronger Python newline anchoring at end-of-line cursors.
- Hardened Python indentation normalization for block bodies, branch alignment (`elif`/`else`/`except`/`finally`), and malformed merged token splitting (for example `...flush()else:`).
- Added stricter quality gates to reject low-confidence or structurally invalid inline candidates (duplicate branch conditions, nested inline imports in block completions, repeated statement spam).
- Added comprehensive regression coverage for Python placement/indent edge cases and pipeline option behavior.

## [0.0.1] - 2026-04-24

- Initial public release.
- Inline and manual completions powered by OpenAI Responses API.
- Sidebar control console with diagnostics and usage charts.
- Daily token limit setting with local-day enforcement.
