import { ValidationError } from "./errors.js";

/**
 * Normalize any ISO 8601 input to the canonical fixed-width form
 * YYYY-MM-DDTHH:mm:ss.sssZ. Date-only inputs become midnight UTC.
 * With one canonical form, lexicographic comparison == chronological.
 * Throws ValidationError on unparseable input.
 */
export function normalizeIso(input: string, label = "timestamp"): string {
  throw new ValidationError(`not implemented (${label})`);
}

/** True if the string is already in canonical form. */
export function isCanonicalIso(input: string): boolean {
  throw new Error("not implemented");
}
