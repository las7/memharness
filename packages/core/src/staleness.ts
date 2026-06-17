// Pure helpers for the source-staleness signal. NO git/subprocess here (I5);
// the memharness-staleness bin (packages/mcp) runs git and feeds these the raw
// exit-code facts. Kept side-effect-free and exhaustively unit-tested.

/** A pin parsed out of a free-text source_ref: a commit SHA and an optional path. */
export interface ParsedSourceRef {
  commit: string;
  path: string | null;
}

// Class body (no brackets) so it composes both as an atom [HEX] and as a
// negation [^HEX] — embedding a bracketed "[0-9a-f]" inside [^...] is the classic
// double-bracket bug.
const HEX = "0-9a-f";
// Structured form: `<repo>@<40-hex>` optionally followed by `:<path>`. The repo
// segment is opaque (we only keep the SHA + path). 40-hex only here — a full SHA
// is unambiguous, so we don't risk a false match on a truncated id.
const STRUCTURED_RE = new RegExp(`@([${HEX}]{40})(?::([^\\s]+))?(?:\\s|$)`);
// Standalone form: a 7–40-hex run bounded by non-hex (or string edges), so a hex
// run embedded in a longer token (e.g. a URL path segment, a content hash) does
// NOT parse — only a genuinely free-standing SHA-looking token.
const STANDALONE_RE = new RegExp(`(?:^|[^${HEX}])([${HEX}]{7,40})(?:[^${HEX}]|$)`);

/**
 * Extract a git pin from a free-text source_ref. Recognizes:
 *   - `repo@<40hex>[:path]`  (structured; path captured)
 *   - a standalone 7–40-hex SHA bounded by non-hex characters
 * Returns null when no SHA is present. CRITICAL: a hex run embedded inside a
 * longer alphanumeric token (a URL, a filename, a non-SHA hash digest) must NOT
 * parse — a mis-parse would pin a fact to a bogus commit and the bin would then
 * report it `unresolved` (exit 128) forever, or worse `stale`. We bias hard
 * toward null over a false SHA (spec §9 open-question 3).
 */
export function parseSourceRef(ref: string | null | undefined): ParsedSourceRef | null {
  if (ref == null) return null;
  const text = ref.trim();
  if (text === "") return null;

  const structured = STRUCTURED_RE.exec(text);
  if (structured) {
    return { commit: structured[1]!, path: structured[2] ?? null };
  }

  // Reject refs that are clearly something-else-with-hex-in-them: a URL or a
  // path-like token containing a `/` or `.` next to the hex run is almost never
  // a bare SHA the agent meant as a pin. Only accept a standalone hex token when
  // the whole ref is, modulo surrounding whitespace, just that token.
  if (/[/.]/.test(text)) return null;

  const standalone = STANDALONE_RE.exec(text);
  if (standalone) {
    return { commit: standalone[1]!, path: null };
  }
  return null;
}

/** The git-derived facts a freshness verdict is computed from. */
export interface FreshnessInputs {
  /** `git merge-base --is-ancestor <commit> HEAD` exit 0 → pin is an ancestor of HEAD. */
  isAncestor: boolean;
  /** Whether the pinned commit equals the current HEAD. */
  sameAsHead: boolean;
  /**
   * Whether the relevant source changed between the pin and HEAD. When a
   * source_path is set this is the path-scoped `git diff --quiet <commit> HEAD
   * -- <path>` result; when NO path is set the bin passes `true` (whole-repo
   * pins are conservatively treated as changed once HEAD moves past them).
   */
  pathChanged: boolean;
  /** Whether the pinned SHA is known in this repo (exit != 128). */
  shaKnown: boolean;
}

/**
 * Map the git-check facts to the three-state verdict (spec §5). The crux is that
 * "we can't tell" (unknown SHA, or a pin that diverged off our branch) maps to
 * `unresolved`, NEVER silently `current` — the operator is neither falsely
 * reassured nor falsely alarmed.
 *
 *   - SHA unknown here (exit 128)          → unresolved
 *   - pin == HEAD                          → current
 *   - pin is an ancestor, HEAD moved on:
 *       path given and unchanged           → current  (an unrelated commit moved HEAD)
 *       path changed, or no path           → stale
 *   - pin not an ancestor (diverged, exit 1) → unresolved
 */
export function classifyFreshness(inputs: FreshnessInputs): "current" | "stale" | "unresolved" {
  if (!inputs.shaKnown) return "unresolved";
  if (inputs.sameAsHead) return "current";
  if (!inputs.isAncestor) return "unresolved";
  // Ancestor of a moved HEAD → candidate stale; a path lets us confirm the
  // file actually changed (else an unrelated commit moved HEAD → still current).
  return inputs.pathChanged ? "stale" : "current";
}
