# Changelog

## [0.1.0] - 2026-11-20

Initial public release of `pi-prime` (π').

- Install the release with `pi install git:github.com/l1ngzi/pi-prime@v0.1.0` on Node.js `>=22.19.0`. Tagged checkouts and release tarballs can download SHA-256-verified binaries. Untagged revisions and modified native sources build locally with Cargo. Run `pi install .` inside a local checkout. For npm, pnpm or Bun installations that skip dependency scripts, run `node <package-dir>/scripts/install-native.mjs`.
- **Native Terminal** (`exec_command`, `write_stdin`, `terminal_sessions`, `/terminal`) supports Windows ConPTY and Job Objects with PowerShell 7, and Unix PTYs and process groups with Bash. Both Windows release binaries use the static CRT. Interactive sessions survive `/reload`, support Ctrl+C, and preserve final output across zero-wait polls. If the helper or shell is missing, Pi keeps its built-in shell tools available.
- Terminal responses default to an 8,000-token head/tail budget. Session logs retain up to 16 MiB. `PI_PRIME_ARTIFACTS_DIR` controls terminal logs and codemode nested-call recovery reports, with a per-user default on Unix. Pi manages ordinary codemode output spills separately.
- **Strict File Tools (`read`, `edit`, `write`)**: Lossless UTF-8 enforcement, binary/UTF-16 guards, exact-match editing that preserves line endings and BOMs, Windows path validation, and `autoResizeImages` support.
- **Adaptive Code Mode & Tool Search**: Seamless drop-in replacement for Pi's built-in `codemode` and `tool_search`, switching GPT models to `codemode: only` and other models to native direct tools + `codemode: on`, with line-mapped QuickJS diagnostics, nested call outcome recovery, and compact TUI terminal cards.
- **Post-Compaction Session Recall (`session_recall`)**: Auto-activates after Pi's built-in compaction for BM25 branch search and paginated exact entry retrieval while respecting branch context edits.
- **Execution Resource Awareness**: Reports cgroup-aware CPU parallelism and memory constraints to the model.
- **OpenRouter Compatibility**: Enables Anthropic inline tool definitions on OpenRouter Claude routes, handles temporary 402 reservation backoffs, and protects Gemini tool receipts from JSON-inference mangling.
- **TUI Polish**: Favorites, drag-reorder, and per-model thinking-level persistence in `/model` (`Ctrl+L`, `Ctrl+S`), plus a live/final `tok/s` status indicator.
