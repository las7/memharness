#!/usr/bin/env node
// memharness-staleness: re-check whether the repo has moved past the commit a
// pinned fact was read at. This is the COLD path and the ONLY place git runs —
// @memharness/core stays git-free (invariant I5), exactly like reembed keeps the
// embedding model out of the write path. It reads the pinned facts, runs git in
// the target repo, classifies a three-state verdict, and writes it back through
// the single narrow setStaleness method. Recall never runs git.
//
// Usage:
//   memharness-staleness            # write verdicts (default --flag)
//   memharness-staleness --check    # compute + print only, no DB write
//   memharness-staleness --repo /path/to/repo   # run git in that repo
import { spawnSync } from "node:child_process";
import {
  type FreshnessInputs,
  Memharness,
  classifyFreshness,
  parseSourceRef,
  resolveDefaultDbPath,
} from "@memharness/core";

const BATCH = 200;

interface Args {
  write: boolean;
  repo: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { write: true, repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.write = false;
    else if (a === "--flag") args.write = true;
    else if (a === "--repo") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--repo needs a value");
      args.repo = v;
    } else throw new Error(`unknown flag ${a}`);
  }
  return args;
}

/** Run git with an args array (no shell — no injection) and return code + trimmed stdout. */
function git(repo: string, gitArgs: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8" });
  if (r.error) {
    // git missing / repo unreadable: surface as an "unknown" code so callers map
    // it to unresolved rather than a false verdict.
    return { code: 127, out: "" };
  }
  return { code: r.status ?? 127, out: (r.stdout ?? "").trim() };
}

const args = parseArgs(process.argv.slice(2));
const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();
const mem = Memharness.open({ dbPath });

// HEAD is per-repo, checked once: every pin in this pass is verified against the
// same HEAD, and we record it in checked_head so the staleness of the check
// itself is visible.
const head = git(args.repo, ["rev-parse", "HEAD"]);
if (head.code !== 0 || head.out === "") {
  process.stderr.write(
    `memharness-staleness: '${args.repo}' is not a usable git repo (git rev-parse HEAD failed); pass --repo <path> to point at the repo your pins belong to.\n`,
  );
  mem.close();
  process.exit(1);
}
const checkedHead = head.out;
const checkedAt = new Date().toISOString();

let checked = 0;
let current = 0;
let stale = 0;
let unresolved = 0;
let backfilled = 0;
const staleIds: number[] = [];

for (;;) {
  // Drain oldest-first. Once verdicts are written they no longer change the
  // work-list ordering (it's id-keyed), so paging by a moving offset is safe.
  const targets = mem.stalenessTargets(BATCH);
  if (targets.length === 0) break;

  for (const t of targets) {
    const sourceCommit = t.sourceCommit;
    let sourcePath = t.sourcePath;
    // First-run backfill: if the structured pin column is somehow empty but the
    // free-text source_ref carries a SHA, adopt it. (stalenessTargets already
    // requires source_commit IS NOT NULL, so this primarily refines source_path
    // when a `repo@sha:path` ref was captured but only the SHA got stored.)
    let backfilledThisRow = false;
    if (sourcePath == null && t.sourceRef) {
      const parsed = parseSourceRef(t.sourceRef);
      if (parsed && parsed.commit === sourceCommit && parsed.path != null) {
        sourcePath = parsed.path;
        backfilledThisRow = true;
      }
    }

    const inputs = classifyOne(args.repo, sourceCommit, sourcePath, checkedHead);
    const verdict = classifyFreshness(inputs);

    checked++;
    if (verdict === "current") current++;
    else if (verdict === "stale") {
      stale++;
      staleIds.push(t.id);
    } else unresolved++;

    if (args.write) {
      mem.setStaleness(t.id, {
        freshness: verdict,
        checkedAt,
        checkedHead,
        ...(backfilledThisRow && sourcePath != null ? { sourcePath } : {}),
      });
      if (backfilledThisRow) backfilled++;
    } else {
      process.stderr.write(
        `  #${t.id} ${verdict}  pin=${(sourcePath ? `${sourcePath}@` : "") + sourceCommit.slice(0, 7)}\n`,
      );
    }
  }

  // In --check mode nothing is written, so the work-list never shrinks: stop
  // after one full page to avoid an infinite loop.
  if (!args.write || targets.length < BATCH) break;
}

mem.close();
const mode = args.write ? "flagged" : "checked (no writes)";
const backfillNote = backfilled > 0 ? ` / backfilled ${backfilled} path(s)` : "";
const summary = [
  `memharness-staleness ${mode} against HEAD ${checkedHead.slice(0, 7)} in ${args.repo}`,
  `checked ${checked} / current ${current} / stale ${stale} / unresolved ${unresolved}${backfillNote}`,
];
if (staleIds.length > 0) summary.push(`stale ids: ${staleIds.map((id) => `#${id}`).join(", ")}`);
process.stderr.write(`${summary.join("\n")}\n`);

/**
 * Run the git primitives for one pin and assemble the FreshnessInputs that
 * classifyFreshness consumes. Maps the three real `merge-base --is-ancestor`
 * exit codes (0 ancestor / 1 diverged / 128 unknown SHA) to the booleans —
 * never silently 'current' for the unverifiable cases.
 */
function classifyOne(
  repo: string,
  commit: string,
  path: string | null,
  headSha: string,
): FreshnessInputs {
  const sameAsHead = commit === headSha;
  if (sameAsHead) {
    return { isAncestor: true, sameAsHead: true, pathChanged: false, shaKnown: true };
  }
  const anc = git(repo, ["merge-base", "--is-ancestor", commit, headSha]);
  // exit 0 → ancestor; exit 1 → diverged (off-branch); exit 128 → unknown SHA.
  const shaKnown = anc.code !== 128 && anc.code !== 127;
  const isAncestor = anc.code === 0;
  let pathChanged = true; // whole-repo pin: conservatively changed once HEAD moved.
  if (isAncestor && path != null && path !== "") {
    // git diff --quiet exits 1 when the path differs, 0 when identical.
    const diff = git(repo, ["diff", "--quiet", commit, headSha, "--", path]);
    pathChanged = diff.code === 1;
  }
  return { isAncestor, sameAsHead, pathChanged, shaKnown };
}
