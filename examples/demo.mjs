// A 30-second tour of what makes memharness different: it remembers *when* it
// believed things, so corrections become history you can query instead of an
// overwrite. Uses a deterministic clock so the time-travel is reproducible.
//
//   cd examples && npm install && npm run demo
import { FakeClock, Memharness } from "@memharness/core";

const e = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = (s) => e(2, s);
const bold = (s) => e(1, s);
const cyan = (s) => e(36, s);
const green = (s) => e(32, s);
const yellow = (s) => e(33, s);
const log = (s = "") => console.log(s);
const beat = () => new Promise((r) => setTimeout(r, 850));

// A controllable clock: each step advances *transaction time* (when the agent
// learned things), which is what makes "what did you believe then?" meaningful.
const clock = new FakeClock("2026-05-01T00:00:00.000Z", 0);
const mem = Memharness.open({ dbPath: ":memory:", clock });

log();
log(bold("  memharness") + dim("  ·  bi-temporal memory for AI agents"));
log();
await beat();

log(dim("  [May 1]  ") + "the agent learns a fact about a project");
const { id } = mem.remember({
  subject: "project:acme",
  fact: "deploys via Heroku",
  sourceRef: "session-may",
});
log("           " + green("remember") + dim(` #${id}  `) + '"deploys via Heroku"');
log();
await beat();

clock.advance(31 * 86_400_000); // -> Jun 1
log(dim("  [Jun 1]  ") + "acting on that belief, it writes a deploy config");
log();
await beat();

clock.advance(15 * 86_400_000); // -> Jun 16
log(dim("  [Jun 16] ") + 'user: "actually we moved to Fly.io back on Jun 5"');
mem.revise({
  oldFactId: id,
  newFact: "deploys via Fly.io",
  validFrom: "2026-06-05T00:00:00.000Z",
  sourceRef: "session-jun",
});
log("           " + yellow("revise") + dim("   superseded, true since Jun 5  -> ") + '"deploys via Fly.io"');
log();
await beat();

log(bold("  Three questions a bag-of-strings can't answer:"));
log();
await beat();

const now = mem.recall({ subject: "project:acme" }).facts[0].fact;
log("  " + cyan("recall") + dim(" (now) ........... ") + bold(now));
await beat();

const then = mem.recall({ subject: "project:acme", asOf: "2026-06-01T12:00:00.000Z" }).facts[0].fact;
log("  " + cyan("recall asOf Jun 1") + dim(" ...... ") + bold(then) + dim("   <- why the Jun 1 config used it"));
await beat();

const w = mem.why(id);
log("  " + cyan("why") + dim(` #${id} ............... `) + dim(`${w.fact.fact}  =>  #${w.descendants[0].id} ${w.descendants[0].fact}`));
await beat();

const d = mem.diff({ since: "2026-06-01T00:00:00.000Z" });
const change = d.revised.map((r) => `${r.old.fact} -> ${r.new.fact}`).join(", ");
log("  " + cyan("diff since Jun 1") + dim(" ....... ") + `${d.revised.length} revised  ` + dim(change));
log();
await beat();

log(dim("  One SQLite file. No LLM calls in the storage layer."));
log(dim("  npx -y @memharness/mcp   ·   github.com/las7/memharness"));
log();
mem.close();
