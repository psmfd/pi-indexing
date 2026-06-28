/**
 * indexing/ccc.ts — the `ccc` subprocess boundary.
 *
 * `resolveBinary` and `assertCliInvocation` are pure and unit-tested; the
 * `defaultRunner` (request/response, for search) and `defaultLauncher`
 * (detached fire-and-forget, for the background re-index) are the real
 * spawn-backed implementations injected at the index.ts boundary.
 *
 * No-MCP guard (ADR-0033 / agent/rules/no-mcp-servers.md): cocoindex-code ships TWO
 * entry points — `ccc` (CLI) and `cocoindex-code` (an MCP stdio server) — and a
 * `ccc mcp` subcommand. assertCliInvocation fails closed on either, so the only
 * thing this extension can ever launch is the CLI search/index/status path.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { CommandResult, DetachedProcess, RunOptions } from "./types.ts";

/** Resolve the `ccc` binary: CCC_BIN_PATH, else PIPX_BIN_DIR/ccc, else ~/.local/bin/ccc. */
export function resolveBinary(env: NodeJS.ProcessEnv): string {
  const explicit = env.CCC_BIN_PATH?.trim();
  if (explicit) return explicit;
  const pipxBin = env.PIPX_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
  return join(pipxBin, "ccc");
}

/**
 * Fail closed unless this is a CLI invocation of `ccc`. Rejects the
 * `cocoindex-code` MCP entry point and the `ccc mcp` subcommand.
 */
export function assertCliInvocation(binary: string, args: ReadonlyArray<string>): void {
  if (basename(binary) !== "ccc") {
    throw new Error(
      `indexing: refusing to spawn '${basename(binary)}' — only the 'ccc' CLI is permitted (no-MCP policy)`,
    );
  }
  if (args[0] === "mcp") {
    throw new Error("indexing: refusing 'ccc mcp' — MCP server mode is prohibited (no-MCP policy)");
  }
}

/**
 * Env vars passed through to the `ccc` subprocess. An ALLOWLIST (not the full
 * `process.env`) so agent-session secrets — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
 * cloud creds, etc. — are never inherited by the external tool, whose full
 * network behavior is opaque to this extension (security review, LLM06/ASI04).
 * Covers what a pipx-installed Python CLI + its local embedding model need:
 * process/locale/temp dirs and the HuggingFace/torch model-cache locations.
 * NOTE: if a future `ccc` release needs another non-secret var, add it here —
 * verified against a real install at the friend-install acceptance step.
 */
const CHILD_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PYTHONUNBUFFERED",
  "PIPX_BIN_DIR",
  "CCC_BIN_PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "HF_HOME",
  "HF_ENDPOINT",
  "HUGGINGFACE_HUB_CACHE",
  "TRANSFORMERS_CACHE",
  "TORCH_HOME",
  // Network/TLS config (non-secret) — the first `ccc index` downloads the local
  // embedding model from HuggingFace, which must work behind a corporate proxy or
  // a custom CA bundle. Both cases of the proxy vars (tools read either).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
];

/**
 * Build the subprocess env: the allowlisted passthrough vars plus the fixed
 * flags that suppress Rich ANSI/spinners and CocoIndex telemetry.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const val = env[key];
    if (val !== undefined) out[key] = val;
  }
  out.TERM = "dumb";
  out.NO_COLOR = "1";
  out.COCOINDEX_DISABLE_USAGE_TRACKING = "1";
  return out;
}

/**
 * Extract a semver from `ccc --version` output (format varies across releases,
 * e.g. "ccc, version 0.2.35" or "ccc 0.2.35"). Pure; returns null if none found.
 */
export function parseCccVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Real search runner: spawn `ccc`, capture output, honor timeout + abort signal. */
export const defaultRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
): Promise<CommandResult> => {
  assertCliInvocation(command, args);
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: childEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: "ccc search timed out" });
    }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: "ccc search aborted" });
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === "ENOENT"
          ? `ccc not found at '${command}' — install with: pipx install 'cocoindex-code[full]' (or set CCC_BIN_PATH)`
          : e.message;
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: hint });
    });
    child.on("close", (code) => finish({ code, stdout: bufStr(out), stderr: bufStr(err) }));
  });
};

/** Real detached launcher for the background re-index (fire-and-forget). */
export const defaultLauncher = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): DetachedProcess => {
  assertCliInvocation(command, args);
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: "ignore",
    detached: true,
  });
  // Fire-and-forget: don't keep the parent's event loop alive waiting on the
  // background re-index (so pi can exit promptly if the session closes mid-index).
  child.unref();
  return {
    pid: child.pid ?? null,
    onExit(callback: (err?: Error) => void): void {
      // ENOENT emits 'error' THEN 'close'; a settled guard ensures the callback
      // fires exactly once and carries the spawn error when present.
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        callback(err);
      };
      child.on("error", (e: Error) => settle(e));
      child.on("close", () => settle());
    },
  };
};

function bufStr(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("utf8");
}
