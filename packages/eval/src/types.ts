import type { MemoryKind } from "@memharness/core";

/** A category of recall difficulty (the axes the research flagged as hardest). */
export type Category =
  | "lexical"
  | "paraphrase"
  | "knowledge-update"
  | "temporal"
  | "multi-session"
  | "importance"
  | "reinforce"
  | "staleness";

/** A timed event replayed to build the memory state. `id` names the created fact. */
export type Event =
  | {
      op: "remember";
      at: string;
      id: string;
      subject: string;
      fact: string;
      importance?: number;
      kind?: MemoryKind;
    }
  | { op: "revise"; at: string; id: string; target: string; fact: string; importance?: number }
  | { op: "forget"; at: string; target: string }
  /** An access that reinforces matching facts (current-mode recall) before a later probe. */
  | { op: "access"; at: string; subject?: string; query?: string }
  /** Mark a created fact's source-staleness verdict, as the staleness bin would. */
  | { op: "stale"; at: string; target: string; freshness?: "stale" | "unresolved" };

/** A query with the fact ids that should appear in the top-k. */
export interface Probe {
  name: string;
  category: Category;
  query?: string;
  subject?: string;
  kind?: MemoryKind;
  asOf?: string;
  k: number;
  /** Event ids whose facts are the gold answers. */
  gold: string[];
}

export interface Dataset {
  epoch: string;
  events: Event[];
  probes: Probe[];
}
