/**
 * model-pin-check tests (#821): the pure evaluation table, HF cache-dir
 * precedence, and the fs probe against a fake hub cache built in a temp dir
 * (no injection seam needed — HF_HUB_CACHE points the probe at the fixture).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkModelPin,
  evaluateModelPin,
  modelCacheDir,
  observeModelPin,
  resolveHfHubCacheDir,
} from "../model-pin-check.ts";

const MODEL_ID = "Snowflake/snowflake-arctic-embed-xs";
const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);
const WEIGHTS = Buffer.from("fake safetensors bytes for #821");
const WEIGHTS_SHA = createHash("sha256").update(WEIGHTS).digest("hex");
const PINS = { revision: REV_A, safetensorsSha256: WEIGHTS_SHA };

// -----------------------------------------------------------------------------
// resolveHfHubCacheDir precedence.
// -----------------------------------------------------------------------------

test("cache dir precedence: HF_HUB_CACHE > legacy alias > HF_HOME > XDG > ~/.cache", () => {
  const home = "/home/u";
  assert.equal(
    resolveHfHubCacheDir(
      { HF_HUB_CACHE: "/a", HUGGINGFACE_HUB_CACHE: "/b", HF_HOME: "/c", XDG_CACHE_HOME: "/d" },
      home,
    ),
    "/a",
  );
  assert.equal(
    resolveHfHubCacheDir({ HUGGINGFACE_HUB_CACHE: "/b", HF_HOME: "/c" }, home),
    "/b",
  );
  assert.equal(resolveHfHubCacheDir({ HF_HOME: "/c" }, home), join("/c", "hub"));
  assert.equal(
    resolveHfHubCacheDir({ XDG_CACHE_HOME: "/d" }, home),
    join("/d", "huggingface", "hub"),
  );
  assert.equal(resolveHfHubCacheDir({}, home), join(home, ".cache", "huggingface", "hub"));
  // Empty/whitespace values are treated as unset, not as a cache path.
  assert.equal(
    resolveHfHubCacheDir({ HF_HUB_CACHE: "  ", HF_HOME: "" }, home),
    join(home, ".cache", "huggingface", "hub"),
  );
});

test("modelCacheDir maps repo-id slashes to the models-- layout", () => {
  assert.equal(
    modelCacheDir("/hub", MODEL_ID),
    join("/hub", "models--Snowflake--snowflake-arctic-embed-xs"),
  );
});

// -----------------------------------------------------------------------------
// evaluateModelPin — the pure decision table.
// -----------------------------------------------------------------------------

test("evaluate: null revision is indeterminate (fail-open, silent)", () => {
  const r = evaluateModelPin({ resolvedRevision: null, weightsSha256: null }, PINS);
  assert.equal(r.status, "indeterminate");
});

test("evaluate: revision drift is reported before any weights comparison", () => {
  // Weights at a drifted revision naturally differ — must NOT misreport as
  // corrupted weights.
  const r = evaluateModelPin({ resolvedRevision: REV_B, weightsSha256: "f".repeat(64) }, PINS);
  assert.equal(r.status, "revision-mismatch");
});

test("evaluate: pinned revision + unreadable weights is indeterminate", () => {
  const r = evaluateModelPin({ resolvedRevision: REV_A, weightsSha256: null }, PINS);
  assert.equal(r.status, "indeterminate");
});

test("evaluate: pinned revision + wrong bytes is weights-mismatch", () => {
  const r = evaluateModelPin({ resolvedRevision: REV_A, weightsSha256: "f".repeat(64) }, PINS);
  assert.equal(r.status, "weights-mismatch");
});

test("evaluate: pinned revision + pinned hash is ok", () => {
  const r = evaluateModelPin({ resolvedRevision: REV_A, weightsSha256: WEIGHTS_SHA }, PINS);
  assert.equal(r.status, "ok");
});

// -----------------------------------------------------------------------------
// observeModelPin / checkModelPin against a fake hub cache.
// -----------------------------------------------------------------------------

/** Build a fake HF hub cache; returns the hub dir. */
function fakeCache(opts: {
  revision?: string;
  refContent?: string;
  weights?: Buffer | null;
  viaSymlink?: boolean;
}): string {
  const hub = mkdtempSync(join(tmpdir(), "model-pin-hub-"));
  const modelDir = modelCacheDir(hub, MODEL_ID);
  const revision = opts.revision ?? REV_A;
  mkdirSync(join(modelDir, "refs"), { recursive: true });
  writeFileSync(join(modelDir, "refs", "main"), opts.refContent ?? `${revision}\n`);
  const snapDir = join(modelDir, "snapshots", revision);
  mkdirSync(snapDir, { recursive: true });
  if (opts.weights) {
    if (opts.viaSymlink) {
      // Mirror the real layout: snapshots/<rev>/model.safetensors -> ../../blobs/<sha>.
      const blobDir = join(modelDir, "blobs");
      mkdirSync(blobDir, { recursive: true });
      const blobPath = join(blobDir, createHash("sha256").update(opts.weights).digest("hex"));
      writeFileSync(blobPath, opts.weights);
      symlinkSync(blobPath, join(snapDir, "model.safetensors"));
    } else {
      writeFileSync(join(snapDir, "model.safetensors"), opts.weights);
    }
  }
  return hub;
}

test("observe: healthy cache via blob symlink resolves revision and hashes real bytes", async (tc) => {
  const hub = fakeCache({ weights: WEIGHTS, viaSymlink: true });
  tc.after(() => rm(hub, { recursive: true, force: true }));
  const obs = await observeModelPin({ HF_HUB_CACHE: hub }, MODEL_ID);
  assert.equal(obs.resolvedRevision, REV_A);
  assert.equal(obs.weightsSha256, WEIGHTS_SHA);
  const { result, warning } = await checkModelPin({ HF_HUB_CACHE: hub }, MODEL_ID, PINS);
  assert.equal(result.status, "ok");
  assert.equal(warning, null);
});

test("observe: absent cache is fully indeterminate and silent", async (tc) => {
  const empty = mkdtempSync(join(tmpdir(), "model-pin-empty-"));
  tc.after(() => rm(empty, { recursive: true, force: true }));
  const { result, warning } = await checkModelPin({ HF_HUB_CACHE: empty }, MODEL_ID, PINS);
  assert.equal(result.status, "indeterminate");
  assert.equal(warning, null);
});

test("observe: garbage refs/main reads as null, not as a comparison", async (tc) => {
  const hub = fakeCache({ refContent: "not a commit hash\n", weights: WEIGHTS });
  tc.after(() => rm(hub, { recursive: true, force: true }));
  const obs = await observeModelPin({ HF_HUB_CACHE: hub }, MODEL_ID);
  assert.equal(obs.resolvedRevision, null);
});

test("check: revision drift warns with both revisions named", async (tc) => {
  const hub = fakeCache({ revision: REV_B, weights: WEIGHTS });
  tc.after(() => rm(hub, { recursive: true, force: true }));
  const { result, warning } = await checkModelPin({ HF_HUB_CACHE: hub }, MODEL_ID, PINS);
  assert.equal(result.status, "revision-mismatch");
  assert.ok(warning?.includes(REV_B) && warning.includes(REV_A), "warning names drift and pin");
});

test("check: corrupted weights at the pinned revision warns as weights mismatch", async (tc) => {
  const hub = fakeCache({ weights: Buffer.from("tampered bytes") });
  tc.after(() => rm(hub, { recursive: true, force: true }));
  const { result, warning } = await checkModelPin({ HF_HUB_CACHE: hub }, MODEL_ID, PINS);
  assert.equal(result.status, "weights-mismatch");
  assert.ok(warning?.includes("NOT the pinned artifact"));
});

test("check: pinned revision but missing safetensors is indeterminate (never downloaded fully)", async (tc) => {
  const hub = fakeCache({ weights: null });
  tc.after(() => rm(hub, { recursive: true, force: true }));
  const { result, warning } = await checkModelPin({ HF_HUB_CACHE: hub }, MODEL_ID, PINS);
  assert.equal(result.status, "indeterminate");
  assert.equal(warning, null);
});
