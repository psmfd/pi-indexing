/**
 * indexing/pin.ts — pinned identity of the external toolchain (ADR-0033, ADR-0009).
 *
 * cocoindex-code (`ccc`) and its local embedding model are acquired out-of-band
 * (`pipx install 'cocoindex-code[full]'`), not by setup.sh's fetch flow, so the
 * "pin" here is a verifiable record rather than a download manifest: the engine
 * version, the embedding-model HuggingFace revision + weights SHA-256 (the
 * trust-on-first-use gate the security review flagged), and the transformers
 * CVE floor (CVE-2026-4372). These constants mirror agent/vendor/cocoindex-code/
 * and are the single source the runtime checks against.
 */

/** Pinned cocoindex-code (`ccc`) engine version. */
export const PINNED_CCC_VERSION = "0.2.35";

/** Local embedding model (the `[full]` extra default; runs offline, no cloud key). */
export const EMBEDDING_MODEL = "Snowflake/snowflake-arctic-embed-xs";

/** Immutable HuggingFace snapshot revision for {@link EMBEDDING_MODEL}. */
export const MODEL_REVISION = "d8c86521100d3556476a063fc2342036d45c106f";

/** SHA-256 of the model weights (`model.safetensors`, 90,272,656 bytes). */
export const MODEL_SAFETENSORS_SHA256 =
  "ee789e0b1d6ecbbd5ce37b474af556cc1a1319cee4417d9e3b11f82e90300706";

/**
 * Minimum `transformers` version free of CVE-2026-4372 (config-injection RCE in
 * 4.56.0–5.2.x; fixed 5.3.0). The `[full]` extra resolved 5.10.2 at pin time.
 */
export const MIN_TRANSFORMERS_VERSION = "5.3.0";
