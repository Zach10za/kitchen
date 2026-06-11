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
    name: 'cook',
    description: 'What should I make today? Optionally tell me ingredients or constraints.',
    options: [
      { name: 'message', description: 'Ingredients on hand or constraints (e.g. "salmon, 20 min")', type: STRING, required: false },
    ],
  },
  {
    name: 'chat',
    description: 'Chat with the kitchen bot in natural language (suggestions, log what you cooked, feedback)',
    options: [
      { name: 'message', description: 'What you want to chat about', type: STRING, required: true },
    ],
  },
  {
    name: 'now',
    description: "What should I be doing in the kitchen right now? (or tonight's options if undecided)",
  },
  {
    name: 'pantry',
    description: 'Update the pantry (e.g., "I bought salmon and bok choy")',
    options: [
      { name: 'message', description: 'What changed in the pantry', type: STRING, required: true },
    ],
  },
  {
    name: 'profile',
    description: 'Show or edit your cooking profile (equipment, diet, cuisines, style — applied to every suggestion)',
    options: [
      { name: 'message', description: 'What to add or change (omit to view current profile)', type: STRING, required: false },
    ],
  },
  {
    name: 'reminders',
    description: 'Show upcoming defrost/prep reminders',
  },
  {
    name: 'grocery',
    description: 'Show or update the grocery list ("got everything" moves it all to the pantry)',
    options: [
      { name: 'message', description: 'What to add/remove/mark bought (omit to view the list)', type: STRING, required: false },
    ],
  },
  {
    name: 'cookbook',
    description: "Your house cookbook: dishes you've cooked and rated, with your next-time notes",
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
  // ─── Projects bot ─────────────────────────────────────────────────
  // Lives in #projects (env key is still DISCORD_TASKS_CHANNEL_ID).
  // Shares the same Discord app + bot token.
  {
    name: 'projects',
    description: 'Track your projects and todos. Without a message shows the project board.',
    options: [
      { name: 'message', description: 'What you want to do (omit to see the project board)', type: STRING, required: false },
    ],
  },
  {
    name: 'projects-open',
    description: 'List all open items (todo, in progress, blocked)',
  },
  {
    name: 'projects-next',
    description: 'Show next actions — steps ready to work on (no unfinished blockers)',
  },
  {
    name: 'projects-blocked',
    description: 'Show items blocked by unfinished dependencies',
  },
  {
    name: 'projects-due',
    description: 'Show overdue items and anything due within the next 7 days',
  },
  // ─── Workout bot ──────────────────────────────────────────────────
  // Lives in #workout. Shares the same Discord app + bot token.
  {
    name: 'workout',
    description: 'Log workouts, track progression, plan programs. Without a message shows a summary.',
    options: [
      { name: 'message', description: 'What you want to do (omit to see a summary)', type: STRING, required: false },
    ],
  },
  {
    name: 'workout-today',
    description: 'Show today\'s planned session card (say "done" in chat to log it as written)',
  },
  {
    name: 'workout-last',
    description: 'Show the most recent workout (every set, grouped by exercise)',
  },
  {
    name: 'workout-prs',
    description: 'Show personal records (estimated 1RMs). Optionally filter to one exercise.',
    options: [
      { name: 'exercise', description: 'Exercise name (omit for top PRs across all lifts)', type: STRING, required: false },
    ],
  },
  {
    name: 'workout-week',
    description: 'Show weekly volume: sets and tonnage by muscle group',
    options: [
      { name: 'days', description: 'Lookback window in days (default 7)', type: INTEGER, required: false },
    ],
  },
  {
    name: 'workout-program',
    description: 'Show the active training program with all routines and planned exercises',
  },
  {
    name: 'workout-profile',
    description: 'Show your lifter profile (bio, goals, preferences, health notes) and home-gym inventory',
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
      let val = trimmed.slice(eq + 1).trim();
      // Strip optional surrounding quotes so values like
      // `FOO="bar baz"` resolve to `bar baz`, not `"bar baz"`.
      if (val.length >= 2) {
        const first = val[0];
        const last = val[val.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          val = val.slice(1, -1);
        }
      }
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
