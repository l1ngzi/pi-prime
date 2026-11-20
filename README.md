# pi-prime (π')

A sharpened, reliable core harness package for [Pi](https://pi.dev).

`pi-prime` stays close to Pi's minimalist philosophy: no heavyweight agent frameworks, no mandatory external API keys, and zero runtime npm dependencies. Instead, it upgrades the foundational runtime layer—terminal execution, file I/O, tool ergonomics, compaction recall, provider compatibility, and TUI controls—so strong base models can work cleanly without harness friction.

## Installation

### From GitHub (recommended)

```bash
pi install git:github.com/l1ngzi/pi-prime@v0.1.0
```

A clean checkout at the release tag downloads the helper for your platform and verifies it against `SHA256SUMS.txt`. Untagged branch revisions and checkouts with local changes under `src/terminal/native` build from local Rust sources. To follow the default branch, use `pi install git:github.com/l1ngzi/pi-prime`.

### Try once without modifying settings

```bash
pi -e git:github.com/l1ngzi/pi-prime@v0.1.0
```

### Local development

```bash
git clone https://github.com/l1ngzi/pi-prime.git
cd pi-prime
npm install
pi install .
```

Pi loads local paths in place. From another directory, use `pi install /path/to/pi-prime`. After editing Rust, run `npm run build` in the checkout to compile the helper and refresh the executable in `bin/`.

### Installing with npm, pnpm or Bun

You can create a package tarball with `npm pack`. In the consuming project, install it with `npm install /path/to/pi-prime-0.1.0.tgz`, `pnpm add /path/to/pi-prime-0.1.0.tgz`, or `bun add /path/to/pi-prime-0.1.0.tgz`, then run `pi install ./node_modules/pi-prime`. A release tarball uses the same verified helper download as the tag. If the package manager skips dependency scripts, run `node <package-dir>/scripts/install-native.mjs`, replacing `<package-dir>` with the installed directory.

When a platform has no release asset or the download is unavailable, the installer tries a locked Cargo build. To use Pi's built-in shell tools, set `PI_PRIME_SKIP_NATIVE_INSTALL=1` during installation. At startup, a missing helper or shell leaves those tools available and produces one warning with the installer path.

> **Tip**: `pi-prime` replaces Pi's built-in `codemode` and `tool-search` extensions automatically out of the box. If you want to silence Pi's startup notice about replaced built-ins, disable `codemode` and `tool-search` under **Built-in** in `pi config` (or add `"-builtin:codemode", "-builtin:tool-search"` to `extensions` in `~/.pi/agent/settings.json`).

### Prerequisites

- **Pi** (`@earendil-works/pi-coding-agent` 1.5.x)
- **Node.js** `>=22.19.0`
- **Windows** requires PowerShell 7 (`pwsh.exe` on `PATH`, install with `winget install Microsoft.PowerShell`). Both Windows release binaries link the Visual C++ runtime statically.
- **Linux / macOS**: `bash` on `PATH`
- **Rust / Cargo**: Optional; only needed when building from source or when no prebuilt release asset matches your platform

## What's Included

| Area | Details |
|---|---|
| **Native Terminal** | `exec_command`, `write_stdin`, `terminal_sessions`, and `/terminal`. Backed by a Rust native helper using ConPTY + Job Objects on Windows and PTY + process groups on Linux/macOS. Supports interactive TTYs, background jobs, Ctrl+C interrupts, and session survival across `/reload`. Each call defaults to an 8,000-token head/tail output budget. Each session log retains up to 16 MiB and reports `log_truncated` when the log is partial. |
| **Strict File Tools** | Drop-in `read`, `edit`, and `write` replacements with UTF-8 validation, UTF-16/binary guards, exact-match editing that preserves existing line endings and BOMs, Windows reserved-name checks, and image `autoResize` support. |
| **Adaptive Code Mode & Tool Search** | Replaces Pi's built-in `codemode` and `tool-search` automatically. Uses `codemode: only` for GPT models and direct tools + optional `codemode` for other models. Adds source-mapped QuickJS error diagnostics, compact schema error messages, nested call outcome recovery, and formatted terminal cards. |
| **Session Recall** | `session_recall` stays hidden until Pi's built-in compaction occurs, then activates automatically for BM25 branch search and paginated exact entry reads while honoring branch context edits. |
| **Execution Resources** | Injects cgroup-aware CPU parallelism and memory constraints into the system prompt so models calibrate builds, workers, and memory usage accurately. |
| **OpenRouter Fixes** | Enables Anthropic inline tool support on OpenRouter Claude routes, retries transient `402` in-flight reservation errors cleanly, and wraps OpenRouter Gemini tool receipts to prevent partial JSON mangling. |
| **Model Selector & TPS** | Enhances `/model` (`Ctrl+L`) with root global search, background catalog refresh, favorites (`Ctrl+D`), drag/Alt-arrow reordering, per-model thinking-level persistence (`→`/`↑`/`↓`), and quick default saving (`Ctrl+S`), stored in `~/.pi/agent/pi-prime-models.json`. Adds a live/final `≈ tok/s` footer status indicator. |

## Environment Variables

All environment variables are optional:

| Variable | Purpose |
|---|---|
| `PI_PRIME_ARTIFACTS_DIR` | Directory for terminal logs and codemode nested-call recovery reports. Defaults to `<tmpdir>/pi-prime-artifacts-<uid>` on Unix and `<tmpdir>/pi-prime-artifacts` on Windows. Inactive artifacts are eligible for cleanup after 14 days. Pi manages ordinary codemode output spills separately. |
| `PI_PRIME_TERMINAL_BIN` | Use an existing `pi-prime-terminal` executable and skip native installation. A missing override path is an installation error. |
| `PI_PRIME_RELEASE_BASE_URL` | Explicit release mirror containing binaries and `SHA256SUMS.txt`. Overrides the checkout tag check. Use HTTPS, or HTTP on loopback for local testing. |
| `PI_PRIME_BUILD_FROM_SOURCE` | Set to `1` during install to skip prebuilt downloads and compile locally with Cargo. |
| `PI_PRIME_FORCE_INSTALL` | Set to `1` to bypass the installed version cache. |
| `PI_PRIME_SKIP_NATIVE_INSTALL` | Set to `1` to skip the `postinstall` native helper step. |

## Development & Testing

```bash
npm install
npm run check          # TypeScript type-checking
cargo test --locked --manifest-path src/terminal/native/Cargo.toml
npm test               # Builds native helper and runs the full test suite
```

## License & Attribution

Licensed under [Apache-2.0](LICENSE). The Windows terminal includes code from OpenAI Codex and WezTerm. The release includes the original attributions and the locked Rust dependencies' license texts. [NOTICE](NOTICE) · [Third-party notices](THIRD-PARTY-NOTICES.txt)
