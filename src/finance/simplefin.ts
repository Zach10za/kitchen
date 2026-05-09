/**
 * SimpleFin Bridge HTTP client.
 *
 * Access URLs from the SimpleFin claim flow embed HTTP Basic credentials
 * (https://USER:PASS@host/path). We parse those out and send them as an
 * explicit `Authorization: Basic` header — Cloudflare Workers' fetch
 * (unlike browsers/Node) does NOT auto-extract inline URL credentials, so
 * leaving them in the URL produces a 403 "No credentials provided".
 *
 * Docs: https://www.simplefin.org/protocol.html
 */

export interface SimplefinTransaction {
  id: string;
  /** Unix seconds when the transaction posted to the account. */
  posted: number;
  /** Decimal string. Negative = outflow, positive = inflow. */
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  /** Pending transactions are excluded by default; only present when ?pending=1. */
  pending?: boolean;
  /** Some institutions provide structured transactedAt separate from posted. */
  transacted_at?: number;
}

export interface SimplefinAccount {
  id: string;
  name: string;
  balance: string;
  /** Decimal string in the account's currency. */
  'available-balance'?: string;
  currency: string;
  org: { name?: string; domain?: string; url?: string };
  transactions: SimplefinTransaction[];
}

export interface SimplefinAccountsResponse {
  errors?: string[];
  accounts: SimplefinAccount[];
}

export interface FetchAccountsOptions {
  /** Unix seconds floor — only return transactions at-or-after this time. */
  startDate?: number;
  /** Unix seconds ceiling — only return transactions at-or-before this time. */
  endDate?: number;
  /** Include pending transactions (default false). */
  pending?: boolean;
}

export class SimplefinClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(accessUrl: string) {
    const parsed = parseAccessUrl(accessUrl);
    this.baseUrl = parsed.baseUrl;
    this.authHeader = parsed.authHeader;
  }

  async fetchAccounts(opts: FetchAccountsOptions = {}): Promise<SimplefinAccountsResponse> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/accounts`);
    if (opts.startDate != null) url.searchParams.set('start-date', String(opts.startDate));
    if (opts.endDate != null) url.searchParams.set('end-date', String(opts.endDate));
    if (opts.pending) url.searchParams.set('pending', '1');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SimpleFin /accounts failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as SimplefinAccountsResponse;
    if (!json.accounts) {
      throw new Error('SimpleFin /accounts response missing `accounts` array.');
    }
    return json;
  }
}

/**
 * Strip inline credentials from the URL and produce a Basic-auth header.
 * URL.username/password are already percent-encoded, so we decode before
 * re-encoding into the base64 form Authorization expects.
 */
function parseAccessUrl(accessUrl: string): { baseUrl: string; authHeader: string } {
  const url = new URL(accessUrl);
  if (!url.username || !url.password) {
    throw new Error('SimpleFin access URL must include embedded user:password credentials.');
  }
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const authHeader = `Basic ${btoa(`${user}:${pass}`)}`;
  url.username = '';
  url.password = '';
  return { baseUrl: url.toString(), authHeader };
}
