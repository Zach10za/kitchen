export interface Env {
  // Bindings
  KITCHEN: DurableObjectNamespace;
  AI: Ai;
  APPROVE_WORKFLOW: Workflow;
  STEER_WORKFLOW: Workflow;

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

  // Secrets
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_CHANNEL_ID: string;
  OPENAI_API_KEY: string;
  AI_GATEWAY_URL: string;
  RELAY_SECRET: string;
  ADMIN_TOKEN: string;
  GITHUB_TOKEN: string;
}
