/**
 * One-shot script to register slash commands with Discord.
 *
 * Usage (after setting env vars in .dev.vars or shell):
 *   bun run scripts/register-commands.ts
 *
 * Re-running is idempotent — Discord overwrites by name within a guild.
 *
 * Required env: DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
 *   (read from process.env; if .dev.vars exists, source it first)
 */

export {};

const STRING = 3;
const INTEGER = 4;

const COMMANDS = [
  {
    name: 'plan',
    description: 'Show the current meal plan or generate one for next week',
  },
  {
    name: 'steer',
    description: 'Steer the plan in natural language (swap meals, change servings, give feedback)',
    options: [
      { name: 'message', description: 'What you want to change', type: STRING, required: true },
    ],
  },
  {
    name: 'now',
    description: 'What should I be doing in the kitchen right now?',
  },
  {
    name: 'pantry',
    description: 'Update the pantry (e.g., "I bought salmon and bok choy")',
    options: [
      { name: 'message', description: 'What changed in the pantry', type: STRING, required: true },
    ],
  },
  {
    name: 'approve',
    description: 'Lock in the current draft and generate a grocery list',
  },
  {
    name: 'grocery',
    description: 'Show the grocery list for the approved plan',
  },
  {
    name: 'profile',
    description: 'Show or edit your cooking profile (equipment, diet, cuisines, style — applied to every plan)',
    options: [
      { name: 'message', description: 'What to add or change (omit to view current profile)', type: STRING, required: false },
    ],
  },
  {
    name: 'draft',
    description: 'Generate a fresh meal plan for next week (~10-15s with live progress)',
    options: [
      { name: 'notes', description: 'Optional constraints for this week (e.g. "guests Friday")', type: STRING, required: false },
    ],
  },
  {
    name: 'reminders',
    description: 'Show upcoming defrost/prep reminders',
  },
  // ─── Finance bot ──────────────────────────────────────────────────
  // Lives in #finance. Shares the same Discord app + bot token.
  {
    name: 'finance',
    description: 'Ask anything about your spending, accounts, or trends. Without a message, shows a 30d summary.',
    options: [
      { name: 'message', description: 'What you want to know (omit to see a quick summary)', type: STRING, required: false },
    ],
  },
  {
    name: 'spending',
    description: 'Quick spending summary with top merchants',
    options: [
      { name: 'days', description: 'Lookback window in days (default 30)', type: INTEGER, required: false },
    ],
  },
  {
    name: 'merchant',
    description: 'Show all transactions and stats for one merchant',
    options: [
      { name: 'name', description: 'Normalized merchant name, e.g. "starbucks", "amazon"', type: STRING, required: true },
      { name: 'days', description: 'Lookback window in days (default 90)', type: INTEGER, required: false },
    ],
  },
  {
    name: 'accounts',
    description: 'List linked bank/card accounts and balances',
  },
  {
    name: 'finance-sync',
    description: 'Pull latest from SimpleFin now (normally syncs hourly)',
  },
  // ─── Tasks bot ────────────────────────────────────────────────────
  // Lives in #tasks. Shares the same Discord app + bot token.
  {
    name: 'tasks',
    description: 'Manage tasks, projects, and todos. Without a message shows a summary.',
    options: [
      { name: 'message', description: 'What you want to do (omit to see a summary)', type: STRING, required: false },
    ],
  },
  {
    name: 'tasks-open',
    description: 'List all open tasks (todo, in progress, blocked)',
  },
  {
    name: 'tasks-next',
    description: 'Show tasks that are ready to work on (no unfinished blockers)',
  },
  {
    name: 'tasks-blocked',
    description: 'Show tasks blocked by unfinished dependencies',
  },
  {
    name: 'tasks-due',
    description: 'Show overdue tasks and anything due within the next 7 days',
  },
];

async function main() {
  // Load .dev.vars if present (simple parser, no dotenv dep needed).
  await loadDevVars();

  const appId = required('DISCORD_APP_ID');
  const botToken = required('DISCORD_BOT_TOKEN');
  const guildId = required('DISCORD_GUILD_ID');

  // Guild-scoped commands appear instantly (vs. up to 1h for global).
  const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!res.ok) {
    console.error(`Registration failed: ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }

  const registered = (await res.json()) as { name: string }[];
  console.log(`Registered ${registered.length} commands in guild ${guildId}:`);
  for (const cmd of registered) console.log(`  /${cmd.name}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var: ${name}`);
    console.error('Set it in .dev.vars or your shell environment.');
    process.exit(1);
  }
  return value;
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
