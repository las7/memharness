import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFreshness } from "@memharness/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end check of the git-exit-code → verdict contract against REAL git.
// The bin (src/staleness.ts) is an entry-point module that runs at import, so we
// don't import it; instead we replicate the exact git primitive sequence it uses
// (rev-parse / merge-base --is-ancestor / diff --quiet) and feed the results
// through the SAME pure classifyFreshness the bin calls. This validates the
// load-bearing claim in STALENESS-SIGNAL.md §5 that merge-base --is-ancestor
// exits 0 (ancestor) / 1 (diverged) / 128 (unknown SHA) on this git, and that
// our mapping is right — the part unit tests of pure helpers can't cover.

const hasGit = spawnSync("git", ["--version"]).status === 0;
const d = hasGit ? describe : describe.skip;

function git(repo: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { code: r.status ?? 127, out: (r.stdout ?? "").trim() };
}

// Mirror of the bin's classifyOne (src/staleness.ts) so the integration test
// exercises the same primitive sequence end-to-end.
function verdict(repo: string, commit: string, path: string | null, head: string): string {
  const sameAsHead = commit === head;
  if (sameAsHead) {
    return classifyFreshness({ isAncestor: true, sameAsHead, pathChanged: false, shaKnown: true });
  }
  const anc = git(repo, ["merge-base", "--is-ancestor", commit, head]);
  const shaKnown = anc.code !== 128;
  const isAncestor = anc.code === 0;
  let pathChanged = true;
  if (isAncestor && path) {
    pathChanged = git(repo, ["diff", "--quiet", commit, head, "--", path]).code === 1;
  }
  return classifyFreshness({ isAncestor, sameAsHead, pathChanged, shaKnown });
}

d("memharness-staleness git classification (real git)", () => {
  let repo: string;
  let c1: string; // first commit (touches a.ts)
  let c2: string; // HEAD (touches b.ts, not a.ts)

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "memharness-stale-"));
    const run = (args: string[]) => {
      const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    };
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.test"]);
    run(["config", "user.name", "t"]);
    run(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "a.ts"), "v1\n");
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "c1"]);
    c1 = git(repo, ["rev-parse", "HEAD"]).out;
    // advance HEAD with a commit that touches b.ts, NOT a.ts
    writeFileSync(join(repo, "b.ts"), "v1\n");
    run(["add", "b.ts"]);
    run(["commit", "-q", "-m", "c2"]);
    c2 = git(repo, ["rev-parse", "HEAD"]).out;
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("pin == HEAD → current", () => {
    expect(verdict(repo, c2, "b.ts", c2)).toBe("current");
  });

  it("ancestor whose path changed since the pin → stale", () => {
    // a.ts existed at c1 (v1) and is unchanged at c2 → its file did not change,
    // so we use b.ts which was ADDED at c2 (changed relative to c1).
    expect(verdict(repo, c1, "b.ts", c2)).toBe("stale");
  });

  it("ancestor whose path did NOT change since the pin → current", () => {
    // a.ts is identical at c1 and c2 → no real drift for a fact about a.ts.
    expect(verdict(repo, c1, "a.ts", c2)).toBe("current");
  });

  it("ancestor with no path (whole-repo pin) on a moved HEAD → stale", () => {
    expect(verdict(repo, c1, null, c2)).toBe("stale");
  });

  it("unknown SHA (exit 128) → unresolved, never current", () => {
    const bogus = "0000000000000000000000000000000000000000";
    expect(verdict(repo, bogus, null, c2)).toBe("unresolved");
  });
});
