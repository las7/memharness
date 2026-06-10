import type { Clock } from "./types.js";

/**
 * Wall-clock with a monotonicity guarantee: if two calls land in the same
 * millisecond, the second is bumped by 1ms. Bi-temporal ordering depends on
 * strictly increasing txAt within a process; cross-process ties are broken
 * by id (rows are never deleted, so id is the insert sequence).
 */
export class SystemClock implements Clock {
  private lastMs = 0;

  now(): string {
    let ms = Date.now();
    if (ms <= this.lastMs) ms = this.lastMs + 1;
    this.lastMs = ms;
    return new Date(ms).toISOString();
  }
}

/** Deterministic clock for tests. Starts at a fixed epoch; advance manually or per-call. */
export class FakeClock implements Clock {
  private ms: number;
  /** Auto-advance per now() call, in ms. 0 = frozen (still monotonic via bump). */
  autoStepMs: number;
  private lastIssued = 0;

  constructor(startIso = "2026-01-01T00:00:00.000Z", autoStepMs = 1000) {
    this.ms = Date.parse(startIso);
    if (Number.isNaN(this.ms)) throw new Error(`FakeClock: bad start ${startIso}`);
    this.autoStepMs = autoStepMs;
  }

  now(): string {
    let issue = this.ms;
    if (issue <= this.lastIssued) issue = this.lastIssued + 1;
    this.lastIssued = issue;
    this.ms = issue + this.autoStepMs;
    return new Date(issue).toISOString();
  }

  /** Advance the clock without issuing a timestamp. */
  advance(ms: number): void {
    this.ms += ms;
  }

  /** The next timestamp now() would issue (before monotonic bump). */
  peek(): string {
    return new Date(this.ms).toISOString();
  }
}
