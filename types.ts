/**
 * indexing/types.ts — shared structural types for the cocoindex-code bridge.
 *
 * The extension shells out to the `ccc` CLI (cocoindex-code) for semantic
 * search and incremental indexing. These types describe the parsed search
 * output and the two injectable process boundaries (a request/response
 * `CommandRunner` for search, a fire-and-forget `DetachedLauncher` for the
 * background re-index) so the pure logic unit-tests without spawning anything.
 * See ADR-0033.
 */

/** One semantic-search hit parsed from `ccc search` text output. */
export interface SearchResult {
  readonly score: number;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: string;
  readonly content: string;
}

/**
 * How a `ccc search` invocation resolved. `ccc` exits 0 even when the project
 * is uninitialized (it prints `Error:` to stdout), so output content — not the
 * exit code alone — drives classification (verified against ccc 0.2.35).
 */
export type OutputKind = "results" | "empty" | "not-initialized" | "error";

export interface ClassifiedOutput {
  readonly kind: OutputKind;
  readonly results: ReadonlyArray<SearchResult>;
  /** Human-facing detail for `error` / `not-initialized`. */
  readonly message: string;
}

/** Result of a completed `ccc` subprocess (search path). */
export interface CommandResult {
  /** Process exit code, or null if killed by signal. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not be spawned (e.g. ENOENT). */
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Injectable request/response runner for the search path. */
export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
) => Promise<CommandResult>;

/** Handle for a detached background process (the re-index). */
export interface DetachedProcess {
  readonly pid: number | null;
  /**
   * Register a callback fired exactly once when the process settles. Receives
   * the spawn/runtime error when the process failed to start or run (e.g.
   * ENOENT), or undefined on a clean exit.
   */
  onExit(callback: (err?: Error) => void): void;
}

/** Injectable fire-and-forget launcher for the background re-index. */
export type DetachedLauncher = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => DetachedProcess;
