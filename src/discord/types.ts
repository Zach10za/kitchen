// Minimal Discord interaction types — just what we use, not the full API.

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

export const ApplicationCommandOptionType = {
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
} as const;

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    options?: CommandOption[];
  };
}
