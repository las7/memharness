import { describe, expect, it } from "vitest";
import { runEval } from "../src/runner.js";

// Offline (synthetic embedder). Validates that the new ranking features move the
// needle on the probes built to isolate them — the harness's reason to exist.
describe("eval harness (synthetic, offline)", () => {
  it("scores every probe under every config arm", async () => {
    const r = await runEval();
    expect(r.embedder).toBe("synthetic");
    // 6 configs × 13 probes
    expect(r.outcomes).toHaveLength(78);
  });

  it("source-staleness demotion helps: the staleness probe hits with it on, misses with it off", async () => {
    const r = await runEval();
    const on = r.outcomes.find((o) => o.config === "hybrid" && o.category === "staleness");
    const off = r.outcomes.find((o) => o.config === "hybrid-noStale" && o.category === "staleness");
    expect(on?.hit).toBe(true);
    expect(off?.hit).toBe(false);
  });

  it("importance helps: the salience probe hits with importance on, misses with it off", async () => {
    const r = await runEval();
    const on = r.outcomes.find((o) => o.config === "hybrid" && o.category === "importance");
    const off = r.outcomes.find((o) => o.config === "hybrid-noImp" && o.category === "importance");
    expect(on?.hit).toBe(true);
    expect(off?.hit).toBe(false);
  });

  it("reinforce-on-access helps: the reinforce probe hits with it on, misses with it off", async () => {
    const r = await runEval();
    const on = r.outcomes.find((o) => o.config === "hybrid" && o.category === "reinforce");
    const off = r.outcomes.find((o) => o.config === "hybrid-noReinf" && o.category === "reinforce");
    expect(on?.hit).toBe(true);
    expect(off?.hit).toBe(false);
  });

  it("knowledge-update returns the current value; as_of recovers the superseded one", async () => {
    const r = await runEval();
    const ku = r.outcomes.find((o) => o.config === "hybrid" && o.category === "knowledge-update");
    const tmp = r.outcomes.find((o) => o.config === "hybrid" && o.category === "temporal");
    expect(ku?.hit).toBe(true);
    expect(tmp?.hit).toBe(true);
  });
});
