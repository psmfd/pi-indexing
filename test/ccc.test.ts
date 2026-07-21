import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertCliInvocation, childEnv, parseCccVersion, resolveBinary } from "../ccc.ts";

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

// #820: childEnv is the security-critical secret-stripping allowlist (LLM06/ASI04).
// A silent widening (e.g. spreading `...env`) must be caught by these tests.
test("childEnv strips agent-session secrets not on the allowlist (#820)", () => {
  const out = childEnv({
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    PATH: "/usr/bin",
  });
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
});

test("childEnv passes allowlisted vars through when present (#820)", () => {
  const out = childEnv({
    PATH: "/usr/bin",
    HF_HOME: "/cache/hf",
    HTTPS_PROXY: "http://proxy:8080",
    SSL_CERT_FILE: "/etc/ca.pem",
  });
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HF_HOME, "/cache/hf");
  assert.equal(out.HTTPS_PROXY, "http://proxy:8080");
  assert.equal(out.SSL_CERT_FILE, "/etc/ca.pem");
});

test("childEnv always sets the fixed no-telemetry / no-ANSI flags (#820)", () => {
  const out = childEnv({});
  assert.equal(out.TERM, "dumb");
  assert.equal(out.NO_COLOR, "1");
  assert.equal(out.COCOINDEX_DISABLE_USAGE_TRACKING, "1");
});
