/**
 * Short, sortable-ish IDs used by tasks/workout DOs. Same construction
 * (`Date.now().toString(36) + 4 chars of randomness`) across both bots —
 * extracted so collision-window changes happen in one place.
 *
 * The 4-char base36 suffix yields ~1.7M combinations per millisecond, which
 * is fine for a single-user side project; if collisions become a real
 * concern, widen the suffix here.
 */
export function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
