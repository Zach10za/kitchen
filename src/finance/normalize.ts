/**
 * Merchant-name normalization. Per-merchant analysis is the user's primary
 * interest, so we strip the most common bank-statement noise and lower-case
 * the result. Anything beyond that (Levenshtein clustering, ML-based
 * canonicalization) is overkill for v1 — the LLM can read the raw description
 * if the cleaned name is wrong.
 *
 * Examples:
 *   "STARBUCKS #1234 SAN FRANCISCO CA"  →  "starbucks"
 *   "SQ *BLUE BOTTLE COFFEE  OAKLAND"   →  "blue bottle coffee"
 *   "TST* ZUNI CAFE        SAN FRANCIS" →  "zuni cafe"
 *   "AMAZON.COM*ABC123"                 →  "amazon"
 *   "UBER   TRIP HELP.UBER.COM"         →  "uber"
 */

const PROCESSOR_PREFIXES = [
  /^SQ\s*\*\s*/i,    // Square
  /^TST\s*\*\s*/i,   // Toast
  /^SP\s*\*\s*/i,    // Shopify
  /^PYPL\s*\*\s*/i,  // PayPal
  /^PP\s*\*\s*/i,    // PayPal
  /^STRP\s*\*\s*/i,  // Stripe
  /^SQU\s*\*\s*/i,   // Square (alt)
];

const NOISE_SUFFIXES = [
  /\s+#\d+.*$/,                 // Store numbers + everything after
  /\s+\d{3,}.*$/,                // Long numeric IDs at end
  /\s+[A-Z]{2}\s*$/,             // Trailing US state code
  /\s+(?:HELP\.|HTTPS?:\/\/|WWW\.).*$/i, // Customer-service URLs at end
  /\.COM\*.*$/i,                 // ".com*orderid"
  /\s{2,}.*$/,                   // Big whitespace gap = location/city block
];

const SPECIFIC_OVERRIDES: { match: RegExp; canonical: string }[] = [
  { match: /^amazon(\s|\*|\.com|$)/i, canonical: 'amazon' },
  { match: /^amzn\b/i,                 canonical: 'amazon' },
  // `^uber\b` so bare "UBER", "UBER *", or "UBER TECHNOLOGIES" all collapse
  // to the same canonical merchant. The previous narrower pattern only
  // matched "UBER EATS" or "UBER TRIP", leaving "UBER TECHNOLOGIES" as a
  // separate merchant.
  { match: /^uber\b/i,                 canonical: 'uber' },
  { match: /^lyft\b/i,                 canonical: 'lyft' },
  { match: /^doordash\b/i,             canonical: 'doordash' },
  { match: /^netflix\b/i,              canonical: 'netflix' },
  { match: /^spotify\b/i,              canonical: 'spotify' },
];

export function normalizeMerchant(rawDescription: string, payee?: string): string {
  // Prefer payee when the bank gave us one — it's usually cleaner than description.
  let s = (payee?.trim() ? payee : rawDescription).trim();

  for (const prefix of PROCESSOR_PREFIXES) s = s.replace(prefix, '');
  for (const suffix of NOISE_SUFFIXES) s = s.replace(suffix, '');

  s = s.trim();
  for (const { match, canonical } of SPECIFIC_OVERRIDES) {
    if (match.test(s)) return canonical;
  }

  return s.toLowerCase().replace(/\s+/g, ' ').trim() || rawDescription.toLowerCase().trim();
}
