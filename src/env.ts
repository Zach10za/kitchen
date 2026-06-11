export interface Env {
  // Bindings
  KITCHEN: DurableObjectNamespace;
  FINANCE: DurableObjectNamespace;
  TASKS: DurableObjectNamespace;
  WORKOUT: DurableObjectNamespace;
  AI: Ai;
  /** Unified chat workflow. Replaces the per-bot *_STEER_WORKFLOW bindings —
   *  one Cloudflare Workflow class (`AgentChatWorkflow`) serves every bot,
   *  parameterized by `botId` in the workflow params. */
  AGENT_CHAT_WORKFLOW: Workflow;

  // Vars
  OPENAI_MODEL: string;
  /** Cheap, fast model for one-shot title generation (error triage). */
  OPENAI_MODEL_FAST: string;
  /** Cheap, fast model for pure structured extraction (pantry parse, recipe materialize). */
  OPENAI_MODEL_EXTRACT: string;
  /** Local hour (0-23) the daily dinner-suggestion ping fires. Defaults to 12 (noon). */
  SUGGEST_HOUR_LOCAL: string;
  /** Local dinner hour (0-23) defrost reminders are anchored to. Defaults to 18. */
  DINNER_HOUR_LOCAL: string;
  /** Local hour (0-23) the projects bot's daily alarm fires: Monday weekly
   *  review + other-day due nudges. Defaults to 9. */
  PROJECTS_REVIEW_HOUR_LOCAL?: string;
  /** Local hour (0-23) the workout bot's daily check-in alarm fires (Monday
   *  recap, inactivity nudges, hiatus welcome-back). Defaults to 9. */
  WORKOUT_CHECKIN_HOUR_LOCAL?: string;
  TIMEZONE: string;
  GITHUB_REPO: string;
  /** Per-channel relay rate limit: max forwarded messages per hour (defaults to 30 if unset). */
  RELAY_RATE_LIMIT_PER_HOUR?: string;
  /** OpenAI pricing in USD per million tokens / per call. Update when OpenAI
   *  changes prices — no code deploy needed. Strings so wrangler vars work. */
  PRICE_INPUT_PER_M?: string;
  PRICE_CACHED_INPUT_PER_M?: string;
  PRICE_OUTPUT_PER_M?: string;
  PRICE_WEB_SEARCH_PER_CALL?: string;
  PRICE_CODE_INTERPRETER_PER_CALL?: string;

  // Secrets
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_CHANNEL_ID: string;
  /** Channel ID where the FinanceDO posts. Required for the finance bot. */
  DISCORD_FINANCE_CHANNEL_ID: string;
  /** Channel ID where the TasksDO posts. Required for the tasks bot. */
  DISCORD_TASKS_CHANNEL_ID: string;
  /** Channel ID where the WorkoutDO posts. Required for the workout bot. */
  DISCORD_WORKOUT_CHANNEL_ID: string;
  OPENAI_API_KEY: string;
  AI_GATEWAY_URL: string;
  RELAY_SECRET: string;
  ADMIN_TOKEN: string;
  GITHUB_TOKEN: string;
  /** Tavily search API key (tvly-…). Powers the shared `web_search` function
   *  tool across all bots. If unset, search degrades gracefully and the model
   *  falls back to its own knowledge. Free tier (~1k searches/mo). */
  TAVILY_API_KEY?: string;
  /** SimpleFin Bridge access URL (https://USER:PASS@.../simplefin). Obtained
   *  by running `bun run scripts/simplefin-claim.ts` once with a setup token. */
  SIMPLEFIN_ACCESS_URL: string;
  /** Google service-account key JSON (the whole file contents). The account's
   *  email must be granted edit access to FINANCE_SHEET_ID. Powers the finance
   *  bot's Google Sheets working layer. If unset, sheet sync no-ops. */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** Spreadsheet id of the finance Google Sheet (the long id in its URL). The
   *  bot creates/maintains a `Transactions` tab in it. Required for sheet sync. */
  FINANCE_SHEET_ID?: string;
}
