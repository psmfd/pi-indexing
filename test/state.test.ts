import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_STATE, load, save } from "../state.ts";
import { saveState } from "../shared/state.ts";

async function tmpAgentDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "pi-suite-indexing-"));
}

test("save then load round-trips state", async () => {
  const dir = await tmpAgentDir();
  const value = { enabled: false, maxResults: 12, maxResultChars: 4000, firstRunNotified: true };
  await save(value, dir);
  assert.deepEqual(await load(dir), value);
});

test("load returns the default when no state file exists", async () => {
  const dir = await tmpAgentDir();
  assert.deepEqual(await load(dir), DEFAULT_STATE);
});

test("load repairs non-positive caps to defaults", async () => {
  const dir = await tmpAgentDir();
  await saveState("indexing", { enabled: true, maxResults: 0, maxResultChars: -5 }, dir);
  const loaded = await load(dir);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.maxResults, DEFAULT_STATE.maxResults);
  assert.equal(loaded.maxResultChars, DEFAULT_STATE.maxResultChars);
});

test("load coerces a non-boolean enabled to false", async () => {
  const dir = await tmpAgentDir();
  await saveState("indexing", { enabled: "yes", maxResults: 5, maxResultChars: 1000 }, dir);
  const loaded = await load(dir);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.maxResults, 5);
});

test("load coerces a non-boolean firstRunNotified to false", async () => {
  const dir = await tmpAgentDir();
  await saveState(
    "indexing",
    { enabled: true, maxResults: 5, maxResultChars: 1000, firstRunNotified: "yes" },
    dir,
  );
  const loaded = await load(dir);
  assert.equal(loaded.firstRunNotified, false);
});
