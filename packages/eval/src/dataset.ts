import type { Dataset } from "./types.js";

/**
 * A small curated, multi-session dataset. Deliberately NOT LoCoMo (its public
 * answer key is ~6.4% wrong). The importance/reinforce probes use isolated
 * subjects so ranking features — not FTS scores — decide the outcome, making
 * those arms verifiable offline. Paraphrase needs the real model (--real).
 */
export const DATASET: Dataset = {
  epoch: "2026-01-01T00:00:00.000Z",
  events: [
    // importance: two equally-fresh, equally-confident facts under one subject
    {
      op: "remember",
      at: "2026-01-01T00:00:00.000Z",
      id: "lang_primary",
      subject: "user:lang",
      fact: "the user's primary programming language is TypeScript",
      importance: 9,
    },
    {
      op: "remember",
      at: "2026-01-02T00:00:00.000Z",
      id: "lang_other",
      subject: "user:lang",
      fact: "the user once tried writing a toy parser in Python",
      importance: 2,
    },
    // knowledge-update + temporal
    {
      op: "remember",
      at: "2026-01-03T00:00:00.000Z",
      id: "city_old",
      subject: "user",
      fact: "the user lives in Osaka",
    },
    {
      op: "revise",
      at: "2026-03-01T00:00:00.000Z",
      id: "city_new",
      target: "city_old",
      fact: "the user lives in Tokyo",
    },
    // reinforce: two equally-old facts under one subject; one gets accessed later
    {
      op: "remember",
      at: "2026-01-01T00:00:00.000Z",
      id: "enjoy_tea",
      subject: "user:enjoy",
      fact: "the user enjoys oolong tea in the afternoon",
    },
    {
      op: "remember",
      at: "2026-01-02T00:00:00.000Z",
      id: "enjoy_coffee",
      subject: "user:enjoy",
      fact: "the user enjoys black coffee in the morning",
    },
    // multi-session: a different subject entirely
    {
      op: "remember",
      at: "2026-01-04T00:00:00.000Z",
      id: "proj_backend",
      subject: "project:outerport",
      fact: "the backend service is built on FastAPI",
    },
    // paraphrase: gold shares no content words with its probe query
    {
      op: "remember",
      at: "2026-01-05T00:00:00.000Z",
      id: "commute",
      subject: "user",
      fact: "rides a bicycle to get around town",
    },
    // distractors under subject "user" so paraphrase top-k needs real ranking
    {
      op: "remember",
      at: "2026-01-06T00:00:00.000Z",
      id: "d1",
      subject: "user",
      fact: "the weather has been rainy this week",
    },
    {
      op: "remember",
      at: "2026-01-07T00:00:00.000Z",
      id: "d2",
      subject: "user",
      fact: "finished reading a long fantasy novel",
    },
    {
      op: "remember",
      at: "2026-01-08T00:00:00.000Z",
      id: "d3",
      subject: "user",
      fact: "adopted a tabby cat named Mochi",
    },
    // access fires late, reinforcing only the tea fact (matches "oolong")
    { op: "access", at: "2026-06-01T00:00:00.000Z", subject: "user:enjoy", query: "oolong" },
  ],
  probes: [
    {
      name: "high-salience fact outranks a trivial one",
      category: "importance",
      subject: "user:lang",
      k: 1,
      gold: ["lang_primary"],
    },
    {
      name: "recalls the corrected (current) value",
      category: "knowledge-update",
      subject: "user",
      query: "where does the user live",
      k: 2,
      gold: ["city_new"],
    },
    {
      name: "as_of recovers the superseded value",
      category: "temporal",
      subject: "user",
      query: "where does the user live",
      asOf: "2026-02-01T00:00:00.000Z",
      k: 2,
      gold: ["city_old"],
    },
    {
      name: "recently-accessed fact outranks an equally-old peer",
      category: "reinforce",
      subject: "user:enjoy",
      k: 1,
      gold: ["enjoy_tea"],
    },
    {
      name: "finds a fact in another subject/session",
      category: "multi-session",
      subject: "project:outerport",
      query: "backend framework",
      k: 3,
      gold: ["proj_backend"],
    },
    {
      name: "plain lexical match",
      category: "lexical",
      subject: "user:enjoy",
      query: "oolong tea",
      k: 3,
      gold: ["enjoy_tea"],
    },
    {
      name: "semantic match with no shared words (real model only)",
      category: "paraphrase",
      subject: "user",
      query: "preferred mode of transport",
      k: 3,
      gold: ["commute"],
    },
  ],
};
