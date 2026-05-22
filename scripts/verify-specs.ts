/**
 * Startup invariants TypeScript can't check.
 *
 * The `BotSpec` interface gets you shape correctness, but a few cross-spec
 * properties only show up at runtime — and when they break, the failure is
 * silent (botForCommand picks the wrong owner, runMigrations skips a duplicate
 * version, dispatchChat lands a thread on the wrong DO). This script asserts
 * them so the next refactor that violates one fails the build, not /chat in
 * Discord.
 *
 * Run via: `bun run verify`
 */

import { BOT_REGISTRY, ALL_BOTS } from '../src/runtime/bot-registry';
import type { BotSpec } from '../src/runtime/bot-spec';

const failures: string[] = [];

function fail(msg: string): void {
  failures.push(msg);
}

// ─── command-set disjointness (excluding kitchen, the catch-all) ──────────
// botForCommand iterates non-kitchen specs and returns the first hit. If two
// non-kitchen bots claim the same command, routing picks whichever iterates
// first — silently wrong on every call.
{
  const owners = new Map<string, BotSpec>();
  for (const spec of ALL_BOTS) {
    if (spec.id === 'kitchen') continue;
    for (const cmd of spec.commands) {
      const prev = owners.get(cmd);
      if (prev) {
        fail(`command "${cmd}" claimed by both ${prev.id} and ${spec.id}`);
      } else {
        owners.set(cmd, spec);
      }
    }
  }
}

// ─── migration version monotonicity ───────────────────────────────────────
// runMigrations skips any version <= the last-applied — a duplicate or out-of-
// order version silently never runs, leaving the schema missing the changes.
for (const spec of ALL_BOTS) {
  let last = 0;
  for (const m of spec.migrations) {
    if (m.version <= last) {
      fail(`${spec.id}: migration version ${m.version} is not strictly greater than previous (${last})`);
    }
    last = m.version;
  }
}

// ─── scopeColumn matches what defaultScope returns ────────────────────────
// The base's prune path reads `spec.scopeColumn` and the workflow IO reads
// `spec.defaultScope().column`. If they disagree, INSERTs land on the wrong
// column and history reads return nothing.
// We pass a stub env that satisfies the {TIMEZONE: string} shape kitchen uses.
const fakeEnv = { TIMEZONE: 'America/New_York' } as any;
for (const spec of ALL_BOTS) {
  const got = spec.defaultScope(fakeEnv, 'verify-channel');
  if (got.column !== spec.scopeColumn) {
    fail(`${spec.id}: scopeColumn=${spec.scopeColumn} but defaultScope().column=${got.column}`);
  }
}

// ─── registry entries match their spec.id ─────────────────────────────────
for (const [id, spec] of Object.entries(BOT_REGISTRY)) {
  if (spec.id !== id) {
    fail(`registry key "${id}" maps to spec with id="${spec.id}"`);
  }
}

if (failures.length > 0) {
  console.error('Spec verification FAILED:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(`Spec verification OK (${ALL_BOTS.length} bots checked)`);
