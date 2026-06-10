/**
 * Independent oracle for bi-temporal correctness: a naive event-replay model
 * with no SQL. Deliberately re-derives the belief-set semantics so the
 * property test compares two independent implementations of the spec.
 *
 * Boundary conventions (must match asof.test.ts):
 *   include txAt == T, include validFrom == T, exclude validTo == T, exclude retractedAt == T
 */

export interface OracleFact {
  id: number;
  subject: string;
  validFrom: string;
  validTo: string | null;
  txAt: string;
  supersededBy: number | null;
  retractedAt: string | null;
  sourceRef: string;
}

export class Oracle {
  readonly facts = new Map<number, OracleFact>();

  remember(args: {
    id: number;
    subject: string;
    validFrom: string;
    txAt: string;
    sourceRef: string;
  }): void {
    this.facts.set(args.id, {
      id: args.id,
      subject: args.subject,
      validFrom: args.validFrom,
      validTo: null,
      txAt: args.txAt,
      supersededBy: null,
      retractedAt: null,
      sourceRef: args.sourceRef,
    });
  }

  revise(args: {
    oldId: number;
    newId: number;
    ts: string;
    validFrom: string;
    subject: string;
  }): void {
    const old = this.facts.get(args.oldId);
    if (!old) throw new Error(`oracle: revise of unknown #${args.oldId}`);
    old.validTo = args.ts;
    old.supersededBy = args.newId;
    this.facts.set(args.newId, {
      id: args.newId,
      subject: args.subject,
      validFrom: args.validFrom,
      validTo: null,
      txAt: args.ts,
      supersededBy: null,
      retractedAt: null,
      sourceRef: "",
    });
  }

  forget(ids: number[], ts: string): void {
    for (const id of ids) {
      const f = this.facts.get(id);
      if (f && f.retractedAt === null) f.retractedAt = ts;
    }
  }

  /** Ids retractable by sourceRef (not yet retracted), mirroring forget-by-source. */
  idsForSourceRef(sourceRef: string): number[] {
    return [...this.facts.values()]
      .filter((f) => f.sourceRef === sourceRef && f.retractedAt === null)
      .map((f) => f.id);
  }

  /** The belief set at instant T: learned by T, valid at T, not yet retracted at T. */
  beliefSet(T: string): Set<number> {
    const out = new Set<number>();
    for (const f of this.facts.values()) {
      if (
        f.txAt <= T &&
        f.validFrom <= T &&
        (f.validTo === null || f.validTo > T) &&
        (f.retractedAt === null || f.retractedAt > T)
      ) {
        out.add(f.id);
      }
    }
    return out;
  }

  /** Current beliefs: open validity, not superseded, not retracted. */
  currentBeliefs(): Set<number> {
    const out = new Set<number>();
    for (const f of this.facts.values()) {
      if (f.validTo === null && f.supersededBy === null && f.retractedAt === null) {
        out.add(f.id);
      }
    }
    return out;
  }

  /** All timestamps at which anything happened, for probe generation. */
  eventTimestamps(): string[] {
    const ts = new Set<string>();
    for (const f of this.facts.values()) {
      ts.add(f.txAt);
      ts.add(f.validFrom);
      if (f.validTo) ts.add(f.validTo);
      if (f.retractedAt) ts.add(f.retractedAt);
    }
    return [...ts].sort();
  }
}
