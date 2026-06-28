/**
 * shared/state.ts — schema-versioned, per-extension JSON state.
 *
 * One state file per extension under the pi agent config dir, matching ADR-0019's
 * per-extension data subtree: `~/.pi/agent/extensions/<namespace>/state.json`.
 * No extension writes another extension's state — every call is namespaced.
 *
 * `agentDir` is injectable so the pure load/save logic unit-tests against a
 * temp dir without touching the real config tree. Default resolution uses
 * `homedir()` (matching the in-repo precedent; this repo does not use
 * PI_CODING_AGENT_DIR — see compaction-optimizer/lib/settings.ts).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Bump only with a migration path; v1 has none (mismatch -> fallback). */
export const STATE_SCHEMA_VERSION = 1;

export interface VersionedState<T> {
  readonly v: number;
  readonly data: T;
}

/** Per-extension state directory: `<agentDir>/extensions/<namespace>/`. */
export function stateDir(namespace: string, agentDir?: string): string {
  const base = agentDir ?? join(homedir(), ".pi", "agent");
  return join(base, "extensions", namespace);
}

/** Per-extension state file: `<agentDir>/extensions/<namespace>/state.json`. */
export function stateFile(namespace: string, agentDir?: string): string {
  return join(stateDir(namespace, agentDir), "state.json");
}

function isVersionedState(value: unknown): value is VersionedState<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    "data" in value &&
    typeof (value as { v: unknown }).v === "number"
  );
}

/**
 * Load state for `namespace`, returning `fallback` when the file is missing,
 * unparseable, or written under a different schema version (no v1 migration).
 */
export async function loadState<T>(namespace: string, fallback: T, agentDir?: string): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(namespace, agentDir), "utf8");
  } catch {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isVersionedState(parsed) || parsed.v !== STATE_SCHEMA_VERSION) {
    return fallback;
  }
  return parsed.data as T;
}

/** Persist `data` for `namespace`, creating the directory as needed. */
export async function saveState<T>(namespace: string, data: T, agentDir?: string): Promise<void> {
  const file = stateFile(namespace, agentDir);
  await fs.mkdir(dirname(file), { recursive: true });
  const payload: VersionedState<T> = { v: STATE_SCHEMA_VERSION, data };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
