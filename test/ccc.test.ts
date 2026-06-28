import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertCliInvocation, parseCccVersion, resolveBinary } from "../ccc.ts";

test("resolveBinary prefers CCC_BIN_PATH", () => {
  assert.equal(resolveBinary({ CCC_BIN_PATH: "/opt/ccc" }), "/opt/ccc");
});

test("resolveBinary falls back to PIPX_BIN_DIR/ccc", () => {
  assert.equal(resolveBinary({ PIPX_BIN_DIR: "/custom/bin" }), join("/custom/bin", "ccc"));
});

test("resolveBinary defaults to ~/.local/bin/ccc", () => {
  assert.equal(resolveBinary({}), join(homedir(), ".local", "bin", "ccc"));
});

test("assertCliInvocation allows the ccc CLI search/index/status paths", () => {
  assert.doesNotThrow(() => assertCliInvocation("/usr/local/bin/ccc", ["search", "foo"]));
  assert.doesNotThrow(() => assertCliInvocation("ccc", ["index"]));
  assert.doesNotThrow(() => assertCliInvocation("ccc", ["status"]));
});

test("assertCliInvocation fails closed on the cocoindex-code MCP entry point", () => {
  assert.throws(() => assertCliInvocation("/usr/local/bin/cocoindex-code", ["search"]), /no-MCP/);
});

test("assertCliInvocation fails closed on the `ccc mcp` subcommand", () => {
  assert.throws(() => assertCliInvocation("ccc", ["mcp"]), /MCP server mode/);
});

test("parseCccVersion extracts a semver from varied --version output", () => {
  assert.equal(parseCccVersion("ccc, version 0.2.35"), "0.2.35");
  assert.equal(parseCccVersion("ccc 0.2.35\n"), "0.2.35");
  assert.equal(parseCccVersion("cocoindex-code 1.10.0 (build x)"), "1.10.0");
  assert.equal(parseCccVersion("no version here"), null);
});
