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

// #820: a header-shaped line embedded INSIDE a hit's content — at a line start but
// NOT followed by a `File:` line — must not truncate the enclosing block. The old
// lazy lookahead terminated on any `--- Result N (score:` substring, mis-splitting
// file:line/language attribution; the line-anchored header+File-line boundary does
// not.
test("parseSearchResults does not split on a header-like line inside content (#820)", () => {
  const raw = `--- Result 1 (score: 0.900) ---
File: src/a.ts:1-5 [typescript]
prefix line
--- Result 99 (score: 0.111) ---
tail line after the fake header`;
  const results = parseSearchResults(raw);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.file, "src/a.ts");
  assert.ok(results[0]?.content.includes("tail line after the fake header"), "content must not be truncated at the embedded fake header");
});

// #820: a generic (non-initialization) Error: diagnostic delivered ONLY on stderr
// with empty stdout must surface that diagnostic, not the generic exit message —
// matching the stdout+stderr scan the not-initialized check already uses.
test("classifyOutput -> error surfaces a stderr-only generic Error: line (#820)", () => {
  const c = classifyOutput("", 1, undefined, "Error: authentication failed");
  assert.equal(c.kind, "error");
  assert.equal(c.message, "authentication failed");
});

// #820: a non-zero exit whose stdout carries a header-shaped fragment that did NOT
// parse into a result is a truncated/malformed real stream, not "no matches" — it
// must classify as error, not empty.
test("classifyOutput -> error on non-zero exit with a header-like-but-unparsed stdout (#820)", () => {
  const c = classifyOutput("--- Result 1 (score: 0.5) --- (File line missing)", 1);
  assert.equal(c.kind, "error");
  assert.ok(c.message.includes("unparsed output"), `expected 'unparsed output', got: ${c.message}`);
});
