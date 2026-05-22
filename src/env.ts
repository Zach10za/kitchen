export interface Env {
  // Bindings
  KITCHEN: DurableObjectNamespace;
  FINANCE: DurableObjectNamespace;
  TASKS: DurableObjectNamespace;
  WORKOUT: DurableObjectNamespace;
  AI: Ai;
  APPROVE_WORKFLOW: Workflow;
  STEER_WORKFLOW: Workflow;
  FINANCE_STEER_WORKFLOW: Workflow;
  TASKS_STEER_WORKFLOW: Workflow;
  WORKOUT_STEER_WORKFLOW: Workflow;

  // Vars
  OPENAI_MODEL: string;
  /** Cheap, fast model for one-shot title generation (error triage). */
  OPENAI_MODEL_FAST: string;
  /** Cheap, fast model for pure structured extraction (pantry parse, recipe materialize). */
  OPENAI_MODEL_EXTRACT: string;
  DRAFT_DAY: string;
  DRAFT_HOUR_LOCAL: string;
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
  /** SimpleFin Bridge access URL (https://USER:PASS@.../simplefin). Obtained
   *  by running `bun run scripts/simplefin-claim.ts` once with a setup token. */
  SIMPLEFIN_ACCESS_URL: string;
}
