# pi-prime (π')

**A sharpened, zero-dependency core harness package for [Pi](https://pi.dev).**

Native Rust PTY terminals, lossless file I/O, adaptive code mode, post-compaction recall, provider transport fixes, and TUI upgrades—packaged as a single drop-in Pi extension with zero runtime npm dependencies and no external API keys required.

[![CI](https://github.com/l1ngzi/pi-prime/actions/workflows/ci.yml/badge.svg)](https://github.com/l1ngzi/pi-prime/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/l1ngzi/pi-prime?label=release)](https://github.com/l1ngzi/pi-prime/releases)
[![npm](https://img.shields.io/npm/v/pi-prime)](https://www.npmjs.com/package/pi-prime)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](package.json)

---

## Benchmarks

Evaluated across three independent full runs (`744` total trials) on **[Frontier Harness v1.1](https://frontierharness.org)** (`62` terminal engineering tasks × `4` attempts = `248` trials per run, `deepseek-flash` with `thinking: max`). All three `pi-prime` runs sit strictly above the official 21-harness Pareto frontier—delivering **+9.3 to +11.7 pp** higher pass rate than stock Pi at the **lowest cost per solved task** (`$0.169/pass`) and **highest prompt cache hit rate** (`99.2%`).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/l1ngzi/pi-prime/main/docs/assets/frontier-harness-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/l1ngzi/pi-prime/main/docs/assets/frontier-harness-light.svg">
    <img alt="Frontier Harness v1.1 benchmark: pi-prime vs 21 official harnesses" src="https://raw.githubusercontent.com/l1ngzi/pi-prime/main/docs/assets/frontier-harness-light.svg" width="100%">
  </picture>
</p>

| Harness | Pass Rate (`n=248`) | TB-2.1 (`n=180`) | TB-4 (`n=68`) | Cost / Trial | Cost / Pass | Cache Hit | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|
| **`pi-prime` (R1)** | **73.0%** (181/248) | **89.4%** | 29.4% | $0.151 | $0.207 | **99.2%** | 14 |
| **`pi-prime` (R2)** | **71.4%** (177/248)<sup>1</sup> | 88.3% | 26.5% | $0.127 | $0.178 | **99.2%** | 13 |
| **`pi-prime` (R3)** | **70.6%** (175/248)<sup>1</sup> | 87.2% | 26.5% | $0.119 | **$0.169** | **99.2%** | **7** |
| ZCode *(#1 official)* | 69.0% (171/248) | 84.4% | 27.9% | $0.153 | $0.222 | 97.3% | 16 |
| Claude Code *(#2 official)* | 68.1% (169/248) | 82.2% | 30.9% | $0.194 | $0.285 | 95.8% | 23 |
| Codex CLI *(#3 official)* | 67.3% (167/248) | 79.4% | **35.3%** | $0.160 | $0.237 | 96.8% | 14 |
| Pi *(stock, #14 official)* | 61.3% (152/248) | 77.2% | 19.1% | $0.129 | $0.210 | 97.0% | 24 |
| OpenCode *(#15, lowest $/trial)* | 61.3% (152/248) | 75.0% | 25.0% | **$0.108** | $0.177 | 96.8% | 17 |

<details>
<summary>Evaluation methodology & notes</summary>

- **Suite & model**: `frontier-harness-eval/frontier-harness-eval@v1.1.0` (45 Terminal-Bench 2.1 + 17 Terminal-Bench 4 tasks, 4 independent attempts per task = 248 trials). Model: `deepseek-flash` (`thinking: max`), with `web_tools: false` and `computer_use: false`.
- **Pricing normalization**: All `pi-prime` runs are repriced using the exact public Frontier Harness token rates (`$0.30/M` uncached input, `$0.007/M` cached input, `$1.20/M` output) for direct apples-to-apples comparison against the 21-harness official leaderboard snapshot (`frontierharness.org`, Nov 2026).
- **Conservative scoring (<sup>1</sup>)**: R2 and R3 had 3 and 2 Modal sandbox OOM errors respectively; all are conservatively scored as `0` under Harbor Mean (`72.2%` on 245 valid trials in R2; `71.1%` on 246 valid trials in R3).
- **Harness lineage**: Evaluated pre-rename as `better-pi` on Pi 1.5.2 (same core runtime shipped in `pi-prime`); stock Pi on the public leaderboard snapshot ran Pi 1.4.0.

</details>

---

## Quick Start

Install from npm (recommended):

```bash
pi install npm:pi-prime
```

Or pin a GitHub release tag:

```bash
pi install git:github.com/l1ngzi/pi-prime@v0.1.0
```

Try once without modifying settings:

```bash
pi -e npm:pi-prime
```

Installation downloads the prebuilt native terminal helper for your platform (`win32`, `linux`, `darwin` × `x64`/`arm64`), verifies its `SHA256SUMS.txt` digest, and falls back to a locked Cargo build only if needed.

> **Tip**: `pi-prime` replaces Pi's built-in `codemode` and `tool-search` extensions automatically. To silence Pi's informational startup notice about replaced built-ins, disable them under **Built-in** in `pi config` (or add `"-builtin:codemode", "-builtin:tool-search"` to `extensions` in `~/.pi/agent/settings.json`).

---

## What It Upgrades

`pi-prime` keeps Pi's minimalist philosophy—no heavyweight orchestration loops or hidden sub-agents—and hardens the foundational runtime layer so strong base models work cleanly without harness friction:

- **Native Persistent Terminal (`exec_command`, `write_stdin`, `terminal_sessions`, `/terminal`)** — Backed by a small Rust helper using ConPTY + Job Objects on Windows (static CRT, UTF-8 console shim across non-UTF-8 locales) and PTY + process groups on Linux/macOS. Supports interactive TTYs, background jobs, `Ctrl+C` interrupts, and session survival across `/reload`. Defaults to an 8,000-token head/tail output budget with 16 MiB session logs. Falls back gracefully to Pi's built-in shell tools if the helper or shell is unavailable.
- **Lossless File I/O (`read`, `edit`, `write`)** — Drop-in replacements with strict UTF-8 validation, UTF-16/NUL binary guards, exact-match editing that preserves mixed line endings and UTF-8 BOMs, Windows reserved-name checks, and image `autoResize` support.
- **Adaptive Code Mode & Tool Search** — Seamlessly replaces Pi's built-in `codemode` and `tool-search`. Automatically routes GPT models to `codemode: only` and other models to direct native tools + optional `codemode`, adding line-mapped QuickJS diagnostics, compact schema validation errors, nested-call recovery logs, and compact terminal cards.
- **Post-Compaction Session Recall (`session_recall`)** — Stays hidden until Pi's built-in compaction occurs, then activates automatically for BM25 branch search and UTF-16-safe paginated entry reads while honoring `context_edit` replacements.
- **Provider & Environment Reliability** — Injects cgroup-aware CPU parallelism and memory limits into the system prompt; enables Anthropic inline tool support and bounded transient `402` reservation retries on OpenRouter Claude routes; wraps OpenRouter Gemini tool receipts to prevent partial JSON mangling.
- **TUI Ergonomics** — Upgrades `/model` (`Ctrl+L`) with root global search, background catalog refresh, favorites (`Ctrl+D`), drag / `Alt+↑`/`↓` reordering, per-model thinking-level persistence (`→` then `↑`/`↓`), and quick default saving (`Ctrl+S`), stored in `~/.pi/agent/pi-prime-models.json`. Adds a live/final `≈ tok/s` footer status indicator.

---

## Requirements

- **Pi**: `@earendil-works/pi-coding-agent` `1.5.x`
- **Node.js**: `>=22.19.0`
- **Shell**: PowerShell 7 (`pwsh.exe` on `PATH`, e.g. `winget install Microsoft.PowerShell`) on Windows; `bash` on Linux/macOS
- **Rust / Cargo**: Optional—only needed when building from source or when no prebuilt release binary matches your platform

---

## Configuration & Development

<details>
<summary>Environment variables (all optional)</summary>

| Variable | Purpose |
|---|---|
| `PI_PRIME_ARTIFACTS_DIR` | Directory for terminal logs and codemode nested-call recovery reports. Defaults to `<tmpdir>/pi-prime-artifacts-<uid>` on Unix and `<tmpdir>/pi-prime-artifacts` on Windows. Inactive artifacts are reaped after 14 days. |
| `PI_PRIME_TERMINAL_BIN` | Path to an existing `pi-prime-terminal` executable (skips native installation; fails if missing). |
| `PI_PRIME_RELEASE_BASE_URL` | Custom HTTPS release mirror (or loopback HTTP for local tests) containing binaries and `SHA256SUMS.txt`. |
| `PI_PRIME_BUILD_FROM_SOURCE` | Set to `1` during install to skip prebuilt downloads and build locally with Cargo. |
| `PI_PRIME_FORCE_INSTALL` | Set to `1` to bypass the installed binary version cache. |
| `PI_PRIME_SKIP_NATIVE_INSTALL` | Set to `1` to skip `postinstall` and keep Pi's built-in shell tools. |

</details>

<details>
<summary>pnpm, Bun, offline installs, and local development</summary>

### Package managers that skip dependency scripts
If you install `pi-prime` via `pnpm` or `bun` and dependency `postinstall` scripts are disabled, run the installer once manually (or follow the startup warning path):

```bash
node <package-dir>/scripts/install-native.mjs
```

### Local development & testing

```bash
git clone https://github.com/l1ngzi/pi-prime.git
cd pi-prime
npm install
pi install .
```

To build and verify locally after editing TypeScript or Rust:

```bash
npm run check                                                   # TypeScript type-checking
cargo test --locked --manifest-path src/terminal/native/Cargo.toml
npm test                                                        # Rebuilds bin/ and runs all 19 test suites
```

</details>

---

## License & Attribution

Licensed under [Apache-2.0](LICENSE). The Windows terminal helper includes code derived from OpenAI Codex (Apache-2.0) and WezTerm ConPTY (MIT). Full upstream attributions and locked Rust dependency license texts ship in [NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
