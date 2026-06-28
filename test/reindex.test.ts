import assert from "node:assert/strict";
import { test } from "node:test";

import { Reindexer } from "../reindex.ts";
import type { DetachedLauncher, DetachedProcess } from "../types.ts";

/** A launcher that records calls and lets the test fire the exit callback. */
function fakeLauncher() {
  const calls: { command: string; args: string[] }[] = [];
  const exits: Array<(err?: Error) => void> = [];
  const launcher: DetachedLauncher = (command, args): DetachedProcess => {
    calls.push({ command, args: [...args] });
    return {
      pid: 123,
      onExit(cb) {
        exits.push(cb);
      },
    };
  };
  return {
    launcher,
    calls,
    finishAll: (err?: Error) => exits.splice(0).forEach((cb) => cb(err)),
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("maybeReindex skips when disabled or not idle", () => {
  const f = fakeLauncher();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {} });
  assert.equal(r.maybeReindex(false, true), "skipped-disabled");
  assert.equal(r.maybeReindex(true, false), "skipped-not-idle");
  assert.equal(f.calls.length, 0);
});

test("maybeReindex launches `ccc index` when enabled and idle", () => {
  const f = fakeLauncher();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {} });
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { command: "ccc", args: ["index"] });
  assert.equal(r.running, true);
});

test("single-flight: a second call while in flight is skipped", () => {
  const f = fakeLauncher();
  const c = clock();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {}, now: c.now });
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(r.maybeReindex(true, true), "skipped-in-flight");
  assert.equal(f.calls.length, 1);
  // After the process exits and the cooldown elapses, it may run again.
  f.finishAll();
  assert.equal(r.running, false);
  c.advance(60_001);
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 2);
});

test("cooldown: a call within the window is skipped after the prior finishes", () => {
  const f = fakeLauncher();
  const c = clock();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {}, now: c.now, cooldownMs: 5000 });
  assert.equal(r.maybeReindex(true, true), "started");
  f.finishAll(); // not in flight anymore
  c.advance(1000); // still inside cooldown
  assert.equal(r.maybeReindex(true, true), "skipped-cooldown");
  c.advance(4001); // past cooldown
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 2);
});

test("forceReindex launches immediately, ignoring idle/cooldown gating", () => {
  const f = fakeLauncher();
  const c = clock();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {}, now: c.now });
  // Not idle, and an immediate second call would be inside any cooldown — force still runs.
  assert.equal(r.forceReindex(), "started");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { command: "ccc", args: ["index"] });
});

test("forceReindex respects the single-flight lock (no double-spawn)", () => {
  const f = fakeLauncher();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {} });
  assert.equal(r.forceReindex(), "started");
  assert.equal(r.forceReindex(), "skipped-in-flight");
  // And it must not race a background re-index into a second concurrent writer.
  assert.equal(r.maybeReindex(true, true), "skipped-in-flight");
  assert.equal(f.calls.length, 1);
  f.finishAll();
  assert.equal(r.running, false);
});

test("onError fires when a launched re-index settles with an error", () => {
  const f = fakeLauncher();
  const errors: Error[] = [];
  const r = new Reindexer({
    launcher: f.launcher,
    binary: "ccc",
    cwd: "/r",
    env: {},
    onError: (e) => errors.push(e),
  });
  assert.equal(r.forceReindex(), "started");
  f.finishAll(new Error("ENOENT"));
  assert.equal(r.running, false, "lock released on failure");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ENOENT/);
});

test("launch resets the single-flight lock if the launcher throws synchronously", () => {
  const throwing: DetachedLauncher = () => {
    throw new Error("bad binary");
  };
  const r = new Reindexer({ launcher: throwing, binary: "nope", cwd: "/r", env: {} });
  assert.throws(() => r.forceReindex(), /bad binary/);
  assert.equal(r.running, false, "lock is not wedged after a throw");
});
