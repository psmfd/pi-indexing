/**
 * toolchain-check tests (#820) — the pure transformers-floor evaluation that backs
 * index.ts's runtime CVE-2026-4372 check. No spawning; the probe output is passed
 * in directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareVersions,
  evaluateTransformersFloor,
  parseTransformersVersion,
} from "../toolchain-check.ts";

test("parseTransformersVersion reads the Version: line from pip show output", () => {
  const out = "Name: transformers\nVersion: 5.10.2\nSummary: ...\n";
  assert.equal(parseTransformersVersion(out), "5.10.2");
});

test("parseTransformersVersion returns null when no Version line is present", () => {
  assert.equal(parseTransformersVersion("WARNING: package not found"), null);
  assert.equal(parseTransformersVersion(""), null);
});

test("compareVersions orders dotted versions numerically (not lexically)", () => {
  assert.ok(compareVersions("5.2.9", "5.3.0") < 0);
  assert.ok(compareVersions("5.10.2", "5.3.0") > 0, "10 > 3 numerically, not '10' < '3' lexically");
  assert.equal(compareVersions("5.3.0", "5.3.0"), 0);
});

test("evaluateTransformersFloor flags a below-floor version", () => {
  const out = "Version: 5.2.9\n";
  const r = evaluateTransformersFloor(out, "5.3.0");
  assert.equal(r.installed, "5.2.9");
  assert.equal(r.belowFloor, true);
});

test("evaluateTransformersFloor accepts a version at or above the floor", () => {
  assert.equal(evaluateTransformersFloor("Version: 5.3.0\n", "5.3.0").belowFloor, false);
  assert.equal(evaluateTransformersFloor("Version: 5.10.2\n", "5.3.0").belowFloor, false);
});

test("evaluateTransformersFloor fails OPEN on a null (unprobeable) result", () => {
  const r = evaluateTransformersFloor(null, "5.3.0");
  assert.equal(r.installed, null);
  assert.equal(r.belowFloor, false);
});

test("evaluateTransformersFloor fails OPEN on unparseable probe output", () => {
  const r = evaluateTransformersFloor("garbage with no version", "5.3.0");
  assert.equal(r.installed, null);
  assert.equal(r.belowFloor, false);
});
