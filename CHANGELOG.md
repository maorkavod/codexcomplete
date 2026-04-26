# Changelog

All notable changes to this project will be documented in this file.

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
