/**
 * indexing/model-pin-check.ts — runtime re-verification of the downloaded
 * embedding model against the pin.ts identity pins (pi_config #821, ADR-0033).
 *
 * Closes the last enforcement gap in the pin.ts map: MODEL_REVISION and
 * MODEL_SAFETENSORS_SHA256 were trust-on-first-use at download and only
 * format/citation-checked by scripts/validate-cocoindex-code-vendor.sh — the
 * actually-downloaded model was never compared to the pin. This module reads
 * the HuggingFace hub cache directly (no subprocess): `refs/main` yields the
 * revision the loader will resolve, and the resolved snapshot's
 * `model.safetensors` is stream-hashed so the comparison is over actual bytes,
 * not the blob symlink's name (downloader metadata, not verification).
 *
 * Enforcement posture mirrors `checkCccVersion`/`checkTransformersFloor`:
 * best-effort and WARN-only, fail OPEN — an absent cache, never-downloaded
 * model, unreadable file, or oversized weights file yields `indeterminate`
 * and stays silent; only a positively-detected mismatch warns. The pure
 * evaluation is separated from the fs probe so the decision logic unit-tests
 * without a cache; the probe itself needs no injection seam — tests build a
 * fake cache in a temp dir and point `HF_HUB_CACHE` at it.
 */

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Refuse to hash a weights file larger than this — the pinned model is ~90 MB;
 * anything approaching the cap is already not the pinned artifact, and the
 * bound keeps a misconfigured cache from turning a best-effort check into
 * minutes of hashing.
 */
export const MAX_HASH_BYTES = 1024 * 1024 * 1024;

/**
 * Resolve the HuggingFace hub cache directory from the environment, matching
 * huggingface_hub's precedence: HF_HUB_CACHE beats the legacy
 * HUGGINGFACE_HUB_CACHE alias, then HF_HOME/hub, then the default HF_HOME of
 * $XDG_CACHE_HOME/huggingface (falling back to ~/.cache/huggingface) + /hub.
 */
export function resolveHfHubCacheDir(env: NodeJS.ProcessEnv, homeDir: string = os.homedir()): string {
  const first = (v: string | undefined): string | null => {
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };
  const hubCache = first(env.HF_HUB_CACHE) ?? first(env.HUGGINGFACE_HUB_CACHE);
  if (hubCache) return hubCache;
  const hfHome = first(env.HF_HOME);
  if (hfHome) return path.join(hfHome, "hub");
  const xdg = first(env.XDG_CACHE_HOME);
  const cacheBase = xdg ?? path.join(homeDir, ".cache");
  return path.join(cacheBase, "huggingface", "hub");
}

/** Hub-cache directory for a `namespace/name` model id (`models--ns--name`). */
export function modelCacheDir(hubCacheDir: string, modelId: string): string {
  return path.join(hubCacheDir, `models--${modelId.replace(/\//g, "--")}`);
}

/** What the fs probe observed; null fields mean "could not determine". */
export interface ModelPinObservation {
  /** Commit hash from `refs/main`, or null when the cache/ref is absent. */
  readonly resolvedRevision: string | null;
  /** SHA-256 of the resolved snapshot's model.safetensors bytes, or null. */
  readonly weightsSha256: string | null;
}

export interface ModelPins {
  readonly revision: string;
  readonly safetensorsSha256: string;
}

export type ModelPinStatus = "ok" | "revision-mismatch" | "weights-mismatch" | "indeterminate";

export interface ModelPinResult {
  readonly status: ModelPinStatus;
  readonly observation: ModelPinObservation;
}

/**
 * Pure evaluation of an observation against the pins. Fail-open: a null
 * resolved revision is `indeterminate` (never warns). Ordering matters:
 * a revision drift is reported as such — the weights at a drifted revision
 * naturally differ from the pin, so comparing them would misreport a (likely
 * benign) upstream update as corrupted weights. `weights-mismatch` is
 * reserved for the serious case: the cache resolves to the PINNED revision
 * but the actual bytes do not hash to the pinned SHA-256.
 */
export function evaluateModelPin(observation: ModelPinObservation, pins: ModelPins): ModelPinResult {
  if (observation.resolvedRevision === null) return { status: "indeterminate", observation };
  if (observation.resolvedRevision !== pins.revision) return { status: "revision-mismatch", observation };
  if (observation.weightsSha256 === null) return { status: "indeterminate", observation };
  if (observation.weightsSha256 !== pins.safetensorsSha256) return { status: "weights-mismatch", observation };
  return { status: "ok", observation };
}

/** Stream-SHA-256 a file; null on any error or when it exceeds MAX_HASH_BYTES. */
async function sha256File(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    return await new Promise<string | null>((resolve) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", () => resolve(null));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  } catch {
    return null;
  }
}

/**
 * Observe the downloaded model in the hub cache. Every failure path yields
 * nulls (→ `indeterminate`, silent); nothing here throws to the caller.
 */
export async function observeModelPin(
  env: NodeJS.ProcessEnv,
  modelId: string,
  homeDir: string = os.homedir(),
): Promise<ModelPinObservation> {
  const modelDir = modelCacheDir(resolveHfHubCacheDir(env, homeDir), modelId);
  let resolvedRevision: string | null = null;
  try {
    const raw = await fs.readFile(path.join(modelDir, "refs", "main"), "utf8");
    const trimmed = raw.trim();
    // A ref must look like a git commit hash; anything else is treated as
    // unreadable rather than compared (fail-open, no garbage in warnings).
    resolvedRevision = /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch {
    resolvedRevision = null;
  }
  if (resolvedRevision === null) return { resolvedRevision: null, weightsSha256: null };

  const weightsSha256 = await sha256File(
    // createReadStream follows the snapshot's symlink into blobs/ (the real
    // bytes); a dangling symlink fails into null like any other read error.
    path.join(modelDir, "snapshots", resolvedRevision, "model.safetensors"),
  );
  return { resolvedRevision, weightsSha256 };
}

/**
 * Convenience composition for the session_start check: observe, evaluate,
 * and render the one-line warning (or null when there is nothing to say).
 */
export async function checkModelPin(
  env: NodeJS.ProcessEnv,
  modelId: string,
  pins: ModelPins,
  homeDir: string = os.homedir(),
): Promise<{ result: ModelPinResult; warning: string | null }> {
  const result = evaluateModelPin(await observeModelPin(env, modelId, homeDir), pins);
  let warning: string | null = null;
  if (result.status === "weights-mismatch") {
    warning =
      `indexing: embedding-model weights hash mismatch for ${modelId} — ` +
      `model.safetensors at revision ${result.observation.resolvedRevision} hashes to ` +
      `${result.observation.weightsSha256} but ${pins.safetensorsSha256} is pinned. ` +
      "The downloaded model is NOT the pinned artifact; re-download it and see pin.ts (ADR-0033).";
  } else if (result.status === "revision-mismatch") {
    warning =
      `indexing: embedding-model revision drift for ${modelId} — the cache resolves ` +
      `refs/main to ${result.observation.resolvedRevision} but ${pins.revision} is pinned. ` +
      "An upstream update was downloaded; review and re-pin (pin.ts, agent/vendor/cocoindex-code/).";
  }
  return { result, warning };
}
