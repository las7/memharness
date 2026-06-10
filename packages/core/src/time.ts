import { ValidationError } from "./errors.js";

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// date + time, optional seconds/fraction, optional Z or ±hh:mm / ±hhmm offset
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Normalize any ISO 8601 input to the canonical fixed-width form
 * YYYY-MM-DDTHH:mm:ss.sssZ. Date-only inputs become midnight UTC; a missing
 * offset is read as UTC (never machine-local — determinism beats convenience).
 * With one canonical form, lexicographic comparison == chronological.
 * Throws ValidationError on unparseable input.
 */
export function normalizeIso(input: string, label = "timestamp"): string {
  const raw = input.trim();
  if (CANONICAL.test(raw)) return raw;

  let parseable: string | null = null;
  if (DATE_ONLY.test(raw)) {
    parseable = `${raw}T00:00:00.000Z`;
  } else if (DATETIME.test(raw)) {
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
    parseable = hasOffset ? raw : `${raw}Z`;
  }
  if (parseable === null) {
    throw new ValidationError(`${label}: not an ISO 8601 date/datetime: ${JSON.stringify(input)}`);
  }
  const ms = Date.parse(parseable);
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${label}: unparseable date: ${JSON.stringify(input)}`);
  }
  return new Date(ms).toISOString();
}

/** True if the string is already in canonical form. */
export function isCanonicalIso(input: string): boolean {
  return CANONICAL.test(input) && new Date(input).toISOString() === input;
}
