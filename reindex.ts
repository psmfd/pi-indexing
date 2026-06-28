/**
 * indexing/reindex.ts — idle-gated, single-flight background re-index.
 *
 * Fires `ccc index` after a prompt completes, but only when the session is idle
 * (`agent_end` + ctx.isIdle), only one at a time (single-flight lock), and at
 * most once per cooldown window. `ccc index` is incremental — a no-op when
 * nothing changed — so the cooldown is a courtesy throttle, not correctness.
 * The clock is injectable so the cooldown unit-tests deterministically.
 */

import type { DetachedLauncher } from "./types.ts";

export type ReindexOutcome =
  | "started"
  | "skipped-disabled"
  | "skipped-not-idle"
  | "skipped-in-flight"
  | "skipped-cooldown";

export interface ReindexerDeps {
  readonly launcher: DetachedLauncher;
  readonly binary: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Defaults to Date.now; injected in tests. */
  readonly now?: () => number;
  /** Minimum gap between re-index launches (ms). Default 60s. */
  readonly cooldownMs?: number;
  /**
   * Invoked when a launched `ccc index` fails to start/run (e.g. ccc not
   * installed). Lets the caller surface an otherwise-silent background failure.
   */
  readonly onError?: (err: Error) => void;
}

export class Reindexer {
  private inFlight = false;
  private lastLaunchAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(private readonly deps: ReindexerDeps) {
    this.now = deps.now ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? 60_000;
  }

  get running(): boolean {
    return this.inFlight;
  }

  /**
   * Attempt a background re-index. `enabled` and `idle` are evaluated by the
   * caller (persisted toggle / session flag, and ctx.isIdle()) and passed in so
   * this stays a pure scheduler over its injected launcher + clock.
   */
  maybeReindex(enabled: boolean, idle: boolean): ReindexOutcome {
    if (!enabled) return "skipped-disabled";
    if (!idle) return "skipped-not-idle";
    if (this.inFlight) return "skipped-in-flight";
    if (this.now() - this.lastLaunchAt < this.cooldownMs) return "skipped-cooldown";
    return this.launch();
  }

  /**
   * Explicit on-demand re-index (the `/index build` command). Bypasses the
   * enabled / idle / cooldown gating — the user asked for it — but STILL respects
   * the single-flight lock so it cannot race a background `agent_end` re-index
   * into two concurrent `ccc index` writers on the same database.
   */
  forceReindex(): ReindexOutcome {
    if (this.inFlight) return "skipped-in-flight";
    return this.launch();
  }

  /**
   * Acquire the single-flight lock and launch `ccc index`. Resets the lock if
   * the launcher throws synchronously (so a bad binary cannot wedge the lock
   * on forever) and on the async exit, surfacing a failure via onError.
   */
  private launch(): ReindexOutcome {
    this.inFlight = true;
    let proc;
    try {
      proc = this.deps.launcher(this.deps.binary, ["index"], {
        cwd: this.deps.cwd,
        env: this.deps.env,
      });
    } catch (err) {
      // Reset the lock and leave the cooldown clock untouched, so a synchronous
      // launcher failure (e.g. a bad binary name) does not impose a cooldown on
      // the next attempt. lastLaunchAt is set only after a successful launch.
      this.inFlight = false;
      throw err;
    }
    this.lastLaunchAt = this.now();
    proc.onExit((err) => {
      this.inFlight = false;
      if (err && this.deps.onError) this.deps.onError(err);
    });
    return "started";
  }
}
