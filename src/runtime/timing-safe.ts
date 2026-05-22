/**
 * Constant-time-ish string compare for shared-secret auth checks
 * (ADMIN_TOKEN, RELAY_SECRET). The length check leaks the secret's byte
 * length to a timing attacker, which is the standard trade-off for a
 * naive constant-time compare and is acceptable for these low-stakes
 * shared secrets.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
