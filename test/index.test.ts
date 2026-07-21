/**
 * indexing — index.ts wiring tests (#820).
 *
 * Exercises the composition layer that stitches the pure modules together: tool +
 * command + flag registration, the `search_codebase` pre-spawn refusal paths, the
 * `SKIP_INDEXING` stand-down, and the once-per-session `firstRunNotified` gate.
 *
 * Hermetic without a live `ccc`: state writes are redirected to a throwaway HOME
 * (shared/state.ts resolves via os.homedir()), so nothing touches the real ~/.pi
 * tree; ccc is not installed in CI, so session_start's `ccc --version` probe and
 * agent_end's detached `ccc index` launch simply ENOENT harmlessly (the launcher
 * still returns "started" synchronously, which is what the gate keys off). The
 * ccc-spawning `/index status|build` branches are not asserted (they need a live
 * ccc), but their command registration is.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Redirect shared/state.ts (os.homedir()-based) to a throwaway dir BEFORE the
// factory's session_start runs state.load/save.
process.env.HOME = mkdtempSync(join(tmpdir(), "indexing-index-test-"));
delete process.env.SKIP_INDEXING;

const mod = await import("../index.ts");
const indexing = mod.default as (pi: unknown) => void;

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ToolResult {
  isError?: boolean;
  content: { readonly text: string }[];
}
interface ToolDef {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}
interface CommandDef {
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface FakePi {
  handlers: Record<string, Handler[]>;
  tools: Record<string, ToolDef>;
  commands: Record<string, CommandDef>;
  flags: Record<string, unknown>;
  flagValues: Record<string, unknown>;
  on(name: string, handler: Handler): void;
  registerFlag(name: string, def: unknown): void;
  registerTool(def: ToolDef): void;
  registerCommand(name: string, def: CommandDef): void;
  getFlag(name: string): unknown;
}

function makePi(): FakePi {
  return {
    handlers: {},
    tools: {},
    commands: {},
    flags: {},
    flagValues: {},
    on(name, handler) {
      (this.handlers[name] ??= []).push(handler);
    },
    registerFlag(name, def) {
      this.flags[name] = def;
    },
    registerTool(def) {
      this.tools[def.name] = def;
    },
    registerCommand(name, def) {
      this.commands[name] = def;
    },
    getFlag(name) {
      return this.flagValues[name];
    },
  };
}

interface CtxOpts {
  hasUI?: boolean;
  idle?: boolean;
  notices?: { message: string; level: string }[];
}
function makeCtx(opts: CtxOpts = {}): unknown {
  const notices = opts.notices ?? [];
  return {
    cwd: process.cwd(),
    hasUI: opts.hasUI ?? false,
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => false,
    ui: {
      hasUI: opts.hasUI ?? false,
      notify(message: string, level: string) {
        notices.push({ message, level });
      },
      setStatus() {
        /* no-op */
      },
    },
  };
}

test("factory registers the search_codebase tool, /index command, --index flag, and lifecycle handlers", () => {
  const pi = makePi();
  indexing(pi);
  assert.ok(pi.tools.search_codebase, "search_codebase tool must be registered");
  assert.ok(pi.commands.index, "/index command must be registered");
  assert.ok(pi.flags.index, "--index flag must be registered");
  assert.ok(pi.handlers.session_start?.length, "session_start handler must be registered");
  assert.ok(pi.handlers.agent_end?.length, "agent_end handler must be registered");
});

test("SKIP_INDEXING=1 stands the extension down (registers nothing)", () => {
  process.env.SKIP_INDEXING = "1";
  try {
    const pi = makePi();
    indexing(pi);
    assert.equal(Object.keys(pi.tools).length, 0);
    assert.equal(Object.keys(pi.commands).length, 0);
    assert.equal(Object.keys(pi.flags).length, 0);
    assert.equal(Object.keys(pi.handlers).length, 0);
  } finally {
    delete process.env.SKIP_INDEXING;
  }
});

test("search_codebase refuses an empty/whitespace query before any spawn", async () => {
  const pi = makePi();
  indexing(pi);
  const r = await pi.tools.search_codebase.execute("t", { query: "   " });
  assert.equal(r.isError, true);
  assert.ok(r.content[0]?.text.includes("non-empty query"), r.content[0]?.text);
});

test("search_codebase refuses an absolute or parent-escaping --path", async () => {
  const pi = makePi();
  indexing(pi);
  const abs = await pi.tools.search_codebase.execute("t", { query: "x", path: "/etc/passwd" });
  assert.equal(abs.isError, true);
  assert.ok(abs.content[0]?.text.includes("relative to the project root"), abs.content[0]?.text);
  const esc = await pi.tools.search_codebase.execute("t", { query: "x", path: "../secrets" });
  assert.equal(esc.isError, true);
  assert.ok(esc.content[0]?.text.includes("escape the project root"), esc.content[0]?.text);
});

test("search_codebase refuses a --path or --lang beginning with '-' (arg-injection guard)", async () => {
  const pi = makePi();
  indexing(pi);
  const p = await pi.tools.search_codebase.execute("t", { query: "x", path: "-rf" });
  assert.equal(p.isError, true);
  assert.ok(p.content[0]?.text.includes("must not start with '-'"), p.content[0]?.text);
  const l = await pi.tools.search_codebase.execute("t", { query: "x", lang: "-rf" });
  assert.equal(l.isError, true);
  assert.ok(l.content[0]?.text.includes("must not start with '-'"), l.content[0]?.text);
});

test("agent_end fires the first-run notice exactly once across sessions (#820)", async () => {
  const pi = makePi();
  indexing(pi);
  const notices: { message: string; level: string }[] = [];

  // session_start loads the default (enabled: true) state into the closure.
  await pi.handlers.session_start[0]?.({}, makeCtx({ hasUI: true, notices }));

  // First idle agent_end: the (default-on) background re-index launches, so the
  // one-time notice fires.
  await pi.handlers.agent_end[0]?.({}, makeCtx({ hasUI: true, idle: true, notices }));
  // Second idle agent_end: firstRunNotified is now persisted true, so no repeat.
  await pi.handlers.agent_end[0]?.({}, makeCtx({ hasUI: true, idle: true, notices }));

  const firstRun = notices.filter((n) => n.message.includes("background re-index started"));
  assert.equal(firstRun.length, 1, `expected exactly one first-run notice, got ${firstRun.length}`);
});
