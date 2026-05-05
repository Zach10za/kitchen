/**
 * Verify a Discord interaction request signature.
 *
 * Uses the Workers-native Web Crypto API with NODE-ED25519. Discord signs
 * every interaction with Ed25519 over `timestamp + body`. Rejecting bad
 * signatures is required — Discord auto-pings the endpoint and will
 * deactivate it if it returns 200 to a forged request.
 */
export async function verifyDiscordRequest(
  request: Request,
  publicKey: string
): Promise<{ valid: boolean; body: string }> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  if (!signature || !timestamp) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body)
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
