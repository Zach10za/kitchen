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

/** Subset of Discord's embed object we use. See https://discord.com/developers/docs/resources/message#embed-object */
export interface Embed {
  title?: string;
  description?: string;
  /** RGB packed integer, e.g. 0x57F287 for Discord green. */
  color?: number;
  url?: string;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  author?: { name: string; icon_url?: string; url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

/** What we send to Discord — content, embeds, or both. */
export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
}

/** Status colors used for plan / grocery / reminder embeds. */
export const EmbedColor = {
  draft: 0xfaa61a,        // amber
  approved: 0x57f287,     // Discord green
  inProgress: 0x5865f2,   // blurple
  archived: 0x747f8d,     // gray
  reminder: 0x3498db,     // blue
  grocery: 0xfee75c,      // yellow
  recipe: 0xeb459e,       // pink
  error: 0xed4245,        // Discord red
} as const;
