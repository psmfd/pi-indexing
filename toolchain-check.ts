/**
 * indexing/toolchain-check.ts — pure evaluation of the external-toolchain pins
 * (pin.ts, ADR-0033) against what is actually installed. The subprocess probes
 * live at the ccc.ts boundary (`defaultTransformersProbe`); this module holds the
 * version parsing/comparison so the decision logic unit-tests without spawning
 * anything.
 *
 * Enforcement posture mirrors `checkCccVersion`: best-effort and WARN-only. The
 * evaluator fails OPEN — an absent or unreadable probe never produces a warning,
 * so a missing pipx / uninstalled model never nags; only a positively-detected
 * below-floor `transformers` (the CVE-2026-4372 RCE floor) does.
 */

/** Extract the `Version: X.Y.Z` value from `pip show transformers` output. */
export function parseTransformersVersion(pipShowOutput: string): string | null {
  const m = pipShowOutput.match(/^Version:\s*(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

/** Numeric compare of dotted `X.Y.Z` strings: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface TransformersFloorResult {
  /** The detected installed version, or null when the probe could not determine it. */
  readonly installed: string | null;
  /** True ONLY when a version was detected AND it is below `floor`. */
  readonly belowFloor: boolean;
}

/**
 * Evaluate probe output against the CVE floor. Fail-open: null (probe failed) or
 * unparseable output yields `belowFloor: false` — the check warns only on a
 * positively-detected vulnerable version, never on absence.
 */
export function evaluateTransformersFloor(
  probeOutput: string | null,
  floor: string,
): TransformersFloorResult {
  const installed = probeOutput === null ? null : parseTransformersVersion(probeOutput);
  if (installed === null) return { installed: null, belowFloor: false };
  return { installed, belowFloor: compareVersions(installed, floor) < 0 };
}
