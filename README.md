# Residual

Orchestration-layer token saving. Not another coding-assistant shell.

> Don't pay to reread what your agent already knows.

Local, in-process plugin. No daemon, no on-device LLM, no GPU. Typical memory target: tens of MB. Prompts stay on the customer's machine. This is **v0 of the first slice** — a working DeepSeek Harness plugin with a tested core and a real-session savings ledger, not a published product yet.

- Product name: Residual
- npm scope: `@residualhq` (the bare name `residual` is already taken by an unrelated framework)
- First host: DeepSeek Harness; Claude Code and Codex adapters come after
- Short-video line stays a separate product
- License: MIT

## Packages

- `packages/core` — `@residualhq/core`: append-only tool gate, layered compaction policy, YAML settings merge, local savings ledger
- `packages/dsh` — `@residualhq/dsh`: DeepSeek Harness plugin (companion + engine)

## Principles

1. Give a tool catalog first; load full schemas on demand; append only so the prompt cache stays intact. Mid-session remove or reorder can bill the whole prefix as a cache miss.
2. Inherit compaction thresholds by provider and model (`models[]` → `providers{}` → `default`); ratio or absolute tokens. Do not guess a context window when an absolute budget must be converted.
3. Measure tokens before and after in a local ledger, and show would-have-paid / paid / saved in catalog dollars. Do not use another LLM as a judge. Do not compress tool descriptions or strict fields with LLMLingua-style compressors.
4. Prompts stay on the customer's machine by default. Cloud is optional and later, for license and the ledger only — not in this slice.

## Requirements

- Node.js 20+ to build and test Residual itself
- DeepSeek Harness `0.2.2-rc.x` (`engines.dsh`: `>=0.2.2-0 <0.3.0-0`; current line verified at `0.2.2-rc.5`) to load the plugin. Official `dsh` itself currently asks for Node 24.9+
- Official `@deepseek-ai/dsh-compaction-basic` (provided by the DSH profile)

## Build and test

```bash
cd /path/to/residual
npm install
npm test
npm run build
```

`npm test` runs the workspace suites (`node:test`). A passing run reports the test count in the summary.

## Install the DSH plugin locally

The package is not published to npm yet. Install from this checkout after a build:

```bash
cd /path/to/residual
npm install
npm run build
dsh plugin --profile web add ./packages/dsh
# or, for a headless profile:
dsh plugin --profile headless add ./packages/dsh
```

An absolute path also works: `dsh plugin --profile web add /path/to/residual/packages/dsh`. Once the package is published, the same incantation becomes `dsh plugin --profile web add @residualhq/dsh`.

`ctx.compaction` is a single-slot seam. The bundle ships `residual-engine` **disabled** so it does not silently sit beside or replace official `compaction-basic`. Enable it in the same profile patch that disables the stock engine, and leave `residual-settings` enabled. It does not claim `ctx.compaction`. Restart the profile after installing. Confirm the layer with `dsh --profile <name> --dump-config`.

### Headless profile (0.2.2-rc.5)

Headless exposes compaction at the top level. In `cordis.patch.yml` for that profile, disable `compaction-basic` and enable `residual-engine` together:

```yaml
- id: compaction-basic
  disabled: true

- id: residual-engine
  disabled: false
  config:
    default:
      threshold: 0.8
      retain: 0.16
```

Headless ships with the local credentials service off. If the profile should use a DeepSeek key already stored in `$DSH_HOME/.credentials.yaml`, also enable the `credentials` row in the same patch. Do not put the key in Residual files or in chat.

### Web profile (0.2.2-rc.5)

A top-level `compaction-basic` / `residual-engine` swap is **not** enough on the official web profile. Live engines sit in isolated `compaction` groups inside the official agent presets. A profile patch replaces the targeted preset's whole config, so each official preset you use must be restated, with only the compaction group swapped:

- disable the nested `compaction-basic`
- insert `residual-engine` enabled, with a ratio-only default (see below)
- keep `command-compact` and the official tool-result pruner
- leave the **top-level** bundle `residual-engine` disabled
- keep `residual-settings` enabled

Refresh those preset restatements when you upgrade DeepSeek Harness, because they copy official preset bodies. Do not disable official compaction without installing Residual in the same group, and do not run both engines at once.

## Settings

Policy is a layered document:

```yaml
residual:
  default:
    threshold: 0.8          # ratio of the adapter-declared window
    retain: 0.16
  providers:
    deepseek:
      threshold: 0.5
  models:
    - provider: deepseek
      model: deepseek-chat
      thresholdTokens: 80000  # absolute tokens; requires a declared window at compact time
      retainTokens: 16000
```

Resolution is per field: a model row that only sets `threshold` still inherits `retain` from the provider or default layer. If a layer states both a ratio and a token form, the token form wins.

Copy `packages/dsh/residual-settings.example.yaml` to `$DSH_HOME/residual-settings.yaml` (usually `~/.dsh/residual-settings.yaml`). The file is a **partial document**: maps recurse, `models[]` is replaced only when restated, and omitted keys keep the mount-row baseline, so a small save cannot wipe model-specific policies. The engine polls this file, so edits apply without a restart.

The engine can start even if the mount config or settings file uses absolute token fields before a context window is known. At construction, Residual boots the official parent with ratio fallbacks and does not invent a window. When a turn later has a declared window, absolute fields are converted exactly. If a turn still has no window, Residual refuses to guess and names the route.

Optional tool gate (off by default in this slice):

```yaml
# on the residual-engine row
toolGate:
  enabled: true
```

When enabled, unused `mcp__*` tools may be hidden once before the first model call; `load()` then appends a schema in the agent scope. There is no unload path.

## Ledger

Compaction results are appended to `$DSH_HOME/residual-ledger.jsonl` (token counts, host, timestamp, session id, and catalog dollar estimates — never prompts). A snapshot at `$DSH_HOME/residual-savings.json` is rewritten after each record so a customer can open one file and see three columns: would-have-paid, paid, and saved.

Dollars are a catalog estimate from the official DeepSeek price page (input tokens only), not a vendor invoice. Because Residual cannot see whether the avoided tokens would have been cache hits, the snapshot stores both a cache-miss figure (`savedUsd`) and a cache-hit figure (`savedUsdIfCached`). After a compaction the engine prints a session line:

```text
[residual] session saved 12345 tokens (before=80000 after=67655), about $0.000272–$0.008148 (would have paid $0.052800, paid $0.044652 at cache-miss off-peak; catalog estimate, not an invoice)
```

Official compaction can shrink the context and still throw (for example, when the result stays above the threshold). Residual still records that shrink, so the savings line is not lost.

## What this slice does not do yet

- No published npm package, GitHub repository, license server, or cloud ledger
- No settings panel or visual session badge (the session line is the v0 badge)
- Does not poll `cordis.patch.yml`; patch-row edits still need a restart unless they are also in `residual-settings.yaml`
- Tool-gate hide/load depends on `agent.ctx.tools.restrict` and `register`; if those host methods are missing, Residual keeps the catalog and ledger but will not invent a filter
- Model-facing `search`/`load` tools are not registered yet
- Official `compactNow` retention and summarization fallback chains are left to the parent engine
- Claude Code and Codex adapters, and a CompactBench-style quality report, come after this slice

## Publish checklist (do not run until you decide to go live)

1. Create the `residualhq` GitHub organization and repository, and the npm `@residualhq` organization.
2. Point this monorepo at that repository; keep `packages/dsh` depending on the published `@residualhq/core` version, not a `file:` path.
3. Bump `@residualhq/core` and `@residualhq/dsh` together, run `npm test`, then publish `core` first and `dsh` second (`publishConfig.access` is already `public`).
4. Do not paste API keys, DSH URL tokens, or ledger files into the repository.
