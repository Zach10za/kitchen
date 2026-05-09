/**
 * One-shot script to exchange a SimpleFin setup token for a long-lived
 * access URL. The access URL is your real credential — store it as a
 * Worker secret and never check it in.
 *
 * Usage:
 *   # token in .dev.vars as SIMPLEFIN_SETUP_TOKEN, or:
 *   bun run scripts/simplefin-claim.ts <setup-token>
 *
 * The setup token is single-use. After a successful claim it is dead;
 * losing the access URL means starting over with a fresh setup token
 * from your SimpleFin Bridge account.
 */

export {};

async function main() {
  await loadDevVars();

  const token = process.argv[2] ?? process.env.SIMPLEFIN_SETUP_TOKEN;
  if (!token) {
    console.error('Missing setup token.');
    console.error('Pass as arg or set SIMPLEFIN_SETUP_TOKEN in .dev.vars.');
    process.exit(1);
  }

  const claimUrl = Buffer.from(token.trim(), 'base64').toString('utf8').trim();
  if (!/^https:\/\//.test(claimUrl)) {
    console.error('Decoded setup token is not an https URL — token may be malformed.');
    console.error(`Got: ${claimUrl.slice(0, 80)}…`);
    process.exit(1);
  }

  console.error(`Claiming against ${new URL(claimUrl).origin}…`);

  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) {
    console.error(`Claim failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const accessUrl = (await res.text()).trim();
  if (!/^https:\/\/.+:.+@/.test(accessUrl)) {
    console.error('Response did not look like an access URL with embedded credentials.');
    console.error(`Got: ${accessUrl.slice(0, 80)}…`);
    process.exit(1);
  }

  // stderr for hints, stdout for the value — easy to pipe.
  console.error('\nAccess URL (store as SIMPLEFIN_ACCESS_URL):');
  console.log(accessUrl);
  console.error('\nNext:');
  console.error('  bunx wrangler secret put SIMPLEFIN_ACCESS_URL');
  console.error('  # paste the URL above when prompted');
  console.error('\nAlso add it to .dev.vars for local dev.');
}

async function loadDevVars(): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const content = await fs.readFile('.dev.vars', 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // No .dev.vars file — fall back to shell env only.
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
