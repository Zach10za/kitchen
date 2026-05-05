export interface Env {
  // Bindings
  KITCHEN: DurableObjectNamespace;
  AI: Ai;
  APPROVE_WORKFLOW: Workflow;
  STEER_WORKFLOW: Workflow;

  // Vars
  OPENAI_MODEL: string;
  DRAFT_DAY: string;
  DRAFT_HOUR_LOCAL: string;
  TIMEZONE: string;

  // Secrets
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_CHANNEL_ID: string;
  OPENAI_API_KEY: string;
  AI_GATEWAY_URL: string;
}
