# indexing

Semantic codebase search for the Pi coding agent, backed by
[`cocoindex-code`](https://pypi.org/project/cocoindex-code/) (the `ccc` CLI).
Registers a `search_codebase` tool so the agent can locate relevant code/docs by
meaning — returning `file:line` snippets — instead of reading whole files, and
keeps the index fresh with an idle-gated background re-index. See
[ADR-0033](https://github.com/psmfd/pi-config/blob/main/adrs/0033-codebase-indexing.md).

## Install

```sh
pi install git:github.com/psmfd/pi-indexing
```

Try it first without installing: `pi -e git:github.com/psmfd/pi-indexing`.

## Why custom (not an adopted extension)

Phase 0 (#328) named two candidate extensions; both were rejected on inspection
(#336, ADR-0033):

- **`@pi-unipi/cocoindex`** targets a *different* engine (the `cocoindex`
  framework + LanceDB, not `ccc`/`cocoindex-code`), has no `agent_end` background
  re-index, and carries an unresolved LanceDB AGPL-contamination caveat.
- **`pi-cocoindex`** (elpapi42) uses the right engine and architecture but is
  stale (no activity since 2026-04-26) and built on the abandoned
  `@mariozechner/*` package namespace, incompatible with pi v0.79.0.

The **engine** (`cocoindex-code`, Apache-2.0, actively maintained) is healthy and
is the real value; this thin extension owns only the pi-side wiring, satisfying
every suite convention by design.

## What it does

- **`search_codebase` tool** — runs `ccc search` (CLI tool-call path) and returns
  ranked snippets. Always available (queries whatever index exists).
- **`agent_end` background re-index** — idle-gated, single-flight, cooldown-throttled
  `ccc index`. `ccc index` is incremental (a no-op when nothing changed).

## Controls

| Control | Effect |
| --- | --- |
| `/index status` | Show toggle state, pinned `ccc` version, and index stats. |
| `/index on` \| `/index off` | Enable/disable the `agent_end` background re-index (persisted). |
| `/index build` | Kick off a `ccc index` now (background). |
| `--index` | Enable the background re-index for this session only. |
| `SKIP_INDEXING=1` | Stand the extension down (yields a project-shipped `search_codebase`). |
| `CCC_BIN_PATH` | Absolute path to the `ccc` binary (else `$PIPX_BIN_DIR/ccc`, else `~/.local/bin/ccc`). |

The search tool is **always** registered; `enabled` governs only the background
re-index.

## Setup (external toolchain)

The engine is installed out-of-band (it is not part of `setup.sh`'s fetch flow):

```bash
pipx install --python python3.13 'cocoindex-code[full]'   # Python >= 3.11 required
ccc init      # creates .cocoindex_code/ (already gitignored); confirms local embeddings
ccc index     # first build downloads the embedding model (~90 MB, one-time)
```

The `[full]` extra runs embeddings **locally** (`Snowflake/snowflake-arctic-embed-xs`),
so no cloud key is needed. The pinned engine version and the embedding-model
revision + weights SHA-256 are recorded in [`pin.ts`](pin.ts) and mirrored under
[`agent/vendor/cocoindex-code/`](https://github.com/psmfd/pi-config/blob/main/agent/vendor/cocoindex-code/).

## Security posture (ADR-0033)

- **No MCP.** `cocoindex-code` ships an MCP server (`ccc mcp`, and the
  `cocoindex-code` entry point). `assertCliInvocation` fails closed on either —
  the extension can only ever launch the `ccc` CLI search/index/status path. Per
  `agent/rules/no-mcp-servers.md`.
- **Untrusted output.** Search hits are indexed *repository content* and may
  carry injection strings. Results enter context as tool output (activity-stream
  visible, not system role), framed with an explicit untrusted-content header and
  hard-capped per-result and per-call.
- **Path containment.** A `--path` glob is rejected if absolute or containing
  `..`, so it cannot escape the project root.
- **Pinned model + CVE floor.** The embedding model is pinned by HF revision +
  weights SHA-256 (trust-on-first-use mitigation); `transformers >= 5.3.0`
  (CVE-2026-4372). Telemetry is disabled (`COCOINDEX_DISABLE_USAGE_TRACKING=1`).

## Coexistence

Uses **`agent_end`** + `session_start` + a `search_codebase` tool + an `/index`
command. No `before_agent_start` (auto-router), `context` (context-manager), or
`session_before_compact` (compaction-optimizer) — no hook collisions. pi requires
globally-unique tool names; `SKIP_INDEXING=1` stands down for a project that
ships its own `search_codebase`.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Factory: tool + `/index` command + `--index` flag + `agent_end` re-index. |
| `ccc.ts` | `ccc` subprocess boundary: binary resolution, no-MCP guard, runner + launcher. |
| `parse.ts` | Parse + classify `ccc search` output (pure). |
| `search.ts` | Query construction, `--path` validation, untrusted result framing (pure). |
| `reindex.ts` | Idle-gated, single-flight, cooldown-throttled background re-index. |
| `state.ts` | Persisted toggle + output caps (`shared/state.ts`). |
| `pin.ts` | Pinned `ccc` version + embedding-model revision/SHA + transformers floor. |
| `types.ts` | Structural types + injectable process boundaries. |

## Tests

`scripts/test-indexing.sh` (also run by `validate.sh`). Pi/typebox imports are
type-only in the tested modules, so the suite runs without installing `ccc`.
