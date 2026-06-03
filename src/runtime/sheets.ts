/**
 * Minimal Google Sheets API v4 client for Cloudflare Workers.
 *
 * Auth is a Google **service account**: the operator creates a service account
 * in Google Cloud, shares the target spreadsheet with its email, and stores the
 * account's JSON key as the `GOOGLE_SERVICE_ACCOUNT_JSON` secret. We mint a
 * short-lived OAuth access token by signing a JWT with the account's RSA
 * private key (RS256) and exchanging it at Google's token endpoint — all via
 * WebCrypto, no external library (the same "do auth natively" approach
 * simplefin.ts takes for Basic auth).
 *
 * Docs:
 *   https://developers.google.com/identity/protocols/oauth2/service-account
 *   https://developers.google.com/sheets/api/reference/rest
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
/** Re-mint the access token this many seconds before its stated expiry. */
const TOKEN_SKEW_SEC = 60;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Subset of the values.batchUpdate request body we use. */
export interface ValueRange {
  /** A1 range, e.g. `Transactions!E5:F5`. */
  range: string;
  values: (string | number | null)[][];
}

/**
 * Parse the `GOOGLE_SERVICE_ACCOUNT_JSON` secret into the two fields we need.
 * Throws a clear error if the secret is missing or malformed so the caller can
 * decide whether to no-op (sheet not configured) or surface the failure.
 */
function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw || !raw.trim()) return null;
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing client_email/private_key.');
  }
  // Secrets stored via `wrangler secret put` keep literal `\n` in the PEM body;
  // normalize them back to real newlines so PEM parsing works either way.
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

/** PEM (PKCS#8) → ArrayBuffer for crypto.subtle.importKey. */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

/** Thin Sheets API v4 wrapper. One instance per DO; caches the access token. */
export class SheetsClient {
  private readonly sa: ServiceAccount;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  private constructor(sa: ServiceAccount) {
    this.sa = sa;
  }

  /** Returns null when no service-account secret is configured, so callers can
   *  no-op gracefully (mirrors SimpleFin's "no access URL → skip" behavior). */
  static fromEnv(serviceAccountJson: string | undefined): SheetsClient | null {
    const sa = parseServiceAccount(serviceAccountJson);
    return sa ? new SheetsClient(sa) : null;
  }

  private async accessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt - TOKEN_SKEW_SEC > nowSec) {
      return this.cachedToken.value;
    }

    const header = base64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64UrlFromString(
      JSON.stringify({
        iss: this.sa.client_email,
        scope: SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: nowSec,
        exp: nowSec + 3600,
      }),
    );
    const unsigned = `${header}.${claim}`;

    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(this.sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );
    const jwt = `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`;

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google token exchange failed: ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Google token response missing access_token.');
    this.cachedToken = {
      value: data.access_token,
      expiresAt: nowSec + (data.expires_in ?? 3600),
    };
    return data.access_token;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${SHEETS_BASE}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sheets API ${path} failed: ${res.status} — ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** List the tab titles + ids in a spreadsheet. */
  async listTabs(spreadsheetId: string): Promise<{ title: string; sheetId: number }[]> {
    const data = await this.api<{
      sheets?: { properties?: { title?: string; sheetId?: number } }[];
    }>(`${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId`);
    return (data.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is { title: string; sheetId: number } => !!p?.title && p.sheetId != null)
      .map((p) => ({ title: p.title, sheetId: p.sheetId }));
  }

  /** Read one A1 range. Missing cells come back as short/!undefined rows. */
  async getValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const data = await this.api<{ values?: string[][] }>(
      `${spreadsheetId}/values/${encodeURIComponent(range)}`,
    );
    return data.values ?? [];
  }

  /** Overwrite multiple ranges in one request (RAW input). */
  async batchUpdateValues(spreadsheetId: string, data: ValueRange[]): Promise<void> {
    if (data.length === 0) return;
    await this.api(`${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
  }

  /**
   * Append rows below the existing data in `range`. Returns the 1-based index
   * of the first appended row (parsed from the response's updatedRange) so the
   * caller can record sheet positions without a follow-up read.
   */
  async appendRows(
    spreadsheetId: string,
    range: string,
    rows: (string | number | null)[][],
  ): Promise<{ firstRow: number | null }> {
    if (rows.length === 0) return { firstRow: null };
    const data = await this.api<{ updates?: { updatedRange?: string } }>(
      `${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: rows }) },
    );
    return { firstRow: parseFirstRow(data.updates?.updatedRange) };
  }

  /** Low-level spreadsheets.batchUpdate (add tab, format header, hide column). */
  async batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
    if (requests.length === 0) return;
    await this.api(`${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }
}

/** Parse `Transactions!A47:H51` → 47. Returns null if unparseable. */
function parseFirstRow(updatedRange: string | undefined): number | null {
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  return m ? Number(m[1]) : null;
}
