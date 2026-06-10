import type {
  DiffInput,
  DiffResult,
  ForgetInput,
  ForgetResult,
  MemharnessOptions,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
  ReviseInput,
  ReviseResult,
  StatsResult,
  WhyResult,
} from "./types.js";

const NOT_IMPLEMENTED = "not implemented";

export class Memharness {
  static open(_opts?: MemharnessOptions): Memharness {
    throw new Error(NOT_IMPLEMENTED);
  }

  remember(_input: RememberInput): RememberResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  recall(_input?: RecallInput): RecallResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  revise(_input: ReviseInput): ReviseResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  diff(_input: DiffInput): DiffResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  why(_factId: number): WhyResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  forget(_input: ForgetInput): ForgetResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  stats(): StatsResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Verifies FTS index consistency and foreign keys; throws on corruption. */
  checkIntegrity(): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  close(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
