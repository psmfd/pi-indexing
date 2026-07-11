import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyOutput, parseSearchResults } from "../parse.ts";

// A faithful sample of real `ccc search` output (ccc 0.2.35, NO_COLOR), with a
// leading blank line and blank-line-separated blocks.
const SAMPLE = `
--- Result 1 (score: 0.541) ---
File: adrs/0002-agent-to-agent-channel.md:17-19 [markdown]
3. Cost estimate was low.
4. No pilot fit.

--- Result 2 (score: 0.518) ---
File: agent/extensions/indexing/ccc.ts:8-12 [typescript]
export function resolveBinary(env) {
  return "ccc";
}
`;

test("parseSearchResults extracts every block with fields", () => {
  const results = parseSearchResults(SAMPLE);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    score: 0.541,
    file: "adrs/0002-agent-to-agent-channel.md",
    startLine: 17,
    endLine: 19,
    language: "markdown",
    content: "3. Cost estimate was low.\n4. No pilot fit.",
  });
  assert.equal(results[1]?.file, "agent/extensions/indexing/ccc.ts");
  assert.equal(results[1]?.language, "typescript");
  assert.equal(results[1]?.startLine, 8);
  assert.equal(results[1]?.endLine, 12);
});

test("parseSearchResults returns [] for output with no result blocks", () => {
  assert.deepEqual(parseSearchResults("nothing here"), []);
  assert.deepEqual(parseSearchResults(""), []);
});

test("classifyOutput -> results when blocks are present (even on exit 0)", () => {
  const c = classifyOutput(SAMPLE, 0);
  assert.equal(c.kind, "results");
  assert.equal(c.results.length, 2);
});

test("classifyOutput -> not-initialized with pi remediation first", () => {
  const banner = "Error: Not in an initialized project directory.\nRun `ccc init`...";
  const c = classifyOutput(banner, 0);
  assert.equal(c.kind, "not-initialized");
  assert.ok(c.message.includes("/index build"));
  assert.ok(c.message.includes("ccc init"));
  assert.ok(c.message.indexOf("/index build") < c.message.indexOf("ccc init"));
  assert.equal(c.results.length, 0);
});

// Some ccc failures put the actionable initialization diagnostic on stderr while
// stdout is empty. The tool should still surface the pi-native remediation path
// instead of collapsing to the generic "ccc search exited 1".
test("classifyOutput -> not-initialized from stderr global settings failure", () => {
  const stderr = "Error: Global settings not found: /home/user/.cocoindex_code/global_settings.yml\nRun `ccc init` to create it with default settings.";
  const c = classifyOutput("", 1, undefined, stderr);
  assert.equal(c.kind, "not-initialized");
  assert.ok(c.message.includes("/index build"));
  assert.ok(c.message.indexOf("/index build") < c.message.indexOf("ccc init"));
  assert.equal(c.results.length, 0);
});

test("classifyOutput -> error on a spawn error (ENOENT)", () => {
  const c = classifyOutput("", null, "ccc not found at '/x/ccc'");
  assert.equal(c.kind, "error");
  assert.ok(c.message.includes("not found"));
});

test("classifyOutput -> error on a generic Error: line", () => {
  const c = classifyOutput("Error: daemon unavailable", 0);
  assert.equal(c.kind, "error");
  assert.equal(c.message, "daemon unavailable");
});

test("classifyOutput -> error on non-zero exit with no results", () => {
  const c = classifyOutput("", 1);
  assert.equal(c.kind, "error");
  assert.ok(c.message.includes("exited 1"));
});

test("classifyOutput -> empty on exit 0 with no results and no error", () => {
  const c = classifyOutput("", 0);
  assert.equal(c.kind, "empty");
  assert.equal(c.results.length, 0);
});
