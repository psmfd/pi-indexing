/**
 * indexing/parse.ts — parse and classify `ccc search` output (pure).
 *
 * Verified against ccc 0.2.35 (piped, NO_COLOR — zero ANSI). Each hit is:
 *
 *   --- Result N (score: 0.NNN) ---
 *   File: <relpath>:<start>-<end> [<language>]
 *   <content, possibly multi-line>
 *
 * blocks separated by a blank line. `ccc` exits 0 even when uninitialized,
 * emitting `Error: Not in an initialized project directory.` to stdout — so
 * classification reads the output, not just the exit code.
 */

import type { ClassifiedOutput, SearchResult } from "./types.ts";

const RESULT_HEADER = /--- Result \d+ \(score:/;

// One result block: a header LINE (line-anchored via the `(?<=^|\n)` lookbehind)
// immediately followed by a `File:` line, then content lazily up to the next such
// header+File pair or end of output. Requiring the header to sit at a line start
// AND to be followed by a `File:` line means a header-shaped substring embedded
// mid-content — or a bare header line not followed by a File line — no longer
// prematurely terminates the block (which previously mis-split the
// file:line/language attribution the tool promises the model it can trust). The
// terminator's `\s*$` is end-of-STRING (no `m` flag, deliberately: `m` would make
// `$` match every line end and truncate content at the first line). ccc's search
// output is a fixed text format with no `--json` (ADR-0033), so parsing is
// unavoidable. Residual, inherent ambiguity: if an indexed hit's content is ITSELF
// a verbatim, well-formed `--- Result N … ---` + `File: …` block (e.g. this
// extension's own parse.test.ts fixture, were it returned as a hit), it is
// indistinguishable from a real boundary in a plain-text stream — an edge ccc's
// tolerant, version-pinned parser (ADR-0033) accepts.
const RESULT_BLOCK =
  /(?<=^|\n)--- Result \d+ \(score: ([\d.]+)\) ---\nFile: (.+?):(\d+)-(\d+) \[([^\]]*)\]\n([\s\S]*?)(?=\n--- Result \d+ \(score: [\d.]+\) ---\nFile: |\s*$)/g;

/** Parse all result blocks from raw search stdout. */
export function parseSearchResults(raw: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const m of raw.matchAll(RESULT_BLOCK)) {
    results.push({
      score: Number.parseFloat(m[1] ?? "0"),
      file: m[2] ?? "",
      startLine: Number.parseInt(m[3] ?? "0", 10),
      endLine: Number.parseInt(m[4] ?? "0", 10),
      language: m[5] ?? "",
      content: (m[6] ?? "").replace(/\s+$/, ""),
    });
  }
  return results;
}

/**
 * Classify a completed search invocation. `spawnError` (e.g. ENOENT) is fatal;
 * the uninitialized-project banner is detected by content; an explicit `Error:`
 * line or a non-zero exit with no parseable results is an error; otherwise the
 * (possibly empty) parsed results are returned.
 */
export function classifyOutput(
  stdout: string,
  code: number | null,
  spawnError?: string,
  stderr = "",
): ClassifiedOutput {
  if (spawnError) {
    return { kind: "error", results: [], message: spawnError };
  }
  const combinedDiagnostics = `${stdout}\n${stderr}`;
  if (/^Error: Not in an initialized project/m.test(combinedDiagnostics) || /^Error: Global settings not found:/m.test(combinedDiagnostics)) {
    return {
      kind: "not-initialized",
      results: [],
      message:
        "the project is not indexed — in pi, run `/index build`; if first-time ccc setup is still missing, run `ccc init` once and then `/index build` again",
    };
  }
  const results = parseSearchResults(stdout);
  if (results.length > 0) {
    return { kind: "results", results, message: "" };
  }
  // Scan stdout AND stderr for a generic `Error:` line: some ccc failures put the
  // actionable diagnostic on stderr with an empty stdout — the same rationale the
  // not-initialized check above already applies to `combinedDiagnostics`.
  const errorLine = combinedDiagnostics.split("\n").find((l) => l.startsWith("Error:"));
  if (errorLine) {
    return { kind: "error", results: [], message: errorLine.replace(/^Error:\s*/, "") };
  }
  if (code !== null && code !== 0) {
    // A non-zero exit with zero parsed results is an error, not "no matches". If a
    // header-shaped fragment IS present but didn't parse into a result, the output
    // was a truncated/malformed real result stream — say so, rather than masking it
    // as an empty result set (which classifyOutput's own contract calls an error).
    const message = RESULT_HEADER.test(stdout)
      ? `ccc search exited ${code} with unparsed output`
      : `ccc search exited ${code}`;
    return { kind: "error", results: [], message };
  }
  return { kind: "empty", results: [], message: "" };
}
