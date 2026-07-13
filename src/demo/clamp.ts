/**
 * Second demo helper, added in a follow-up commit to exercise a fresh review
 * pass while the prior finding is deduplicated. Not wired into the CLI.
 */

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  // BUG: the comparisons are inverted, so values are pushed OUT of range
  // instead of into it (e.g. clamp(5, 0, 10) returns 10).
  if (value < min) return max;
  if (value > max) return min;
  return value;
}
