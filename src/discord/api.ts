/**
 * Thin wrapper over Discord REST API. Only the calls we use:
 *   - send a new message to a channel (proactive draft)
 *   - send a follow-up message via interaction webhook (response to slash command)
 *   - edit the original interaction response
 */

const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordAPI {
  constructor(private botToken: string, private appId: string) {}

  /** Post a new message to a channel (used by the alarm-driven draft). */
  async postMessage(channelId: string, content: string): Promise<{ id: string }> {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord postMessage failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Send a follow-up message in response to an interaction (after deferring). */
  async followUp(interactionToken: string, content: string): Promise<void> {
    const res = await fetch(
      `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      }
    );
    if (!res.ok) throw new Error(`Discord followUp failed: ${res.status} ${await res.text()}`);
  }

  /** Edit the deferred response (preferred when the agent finishes within ~15 min). */
  async editOriginal(interactionToken: string, content: string): Promise<void> {
    const res = await fetch(
      `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      }
    );
    if (!res.ok) throw new Error(`Discord editOriginal failed: ${res.status} ${await res.text()}`);
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bot ${this.botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'KitchenBot (https://github.com/zachloza/kitchen, 0.1)',
    };
  }
}
