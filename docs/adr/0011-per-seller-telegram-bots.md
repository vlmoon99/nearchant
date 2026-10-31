# 0011 — Each seller brings their own Telegram bot

**Decision.** No platform bot. A seller pastes a BotFather token in the dashboard. The token is encrypted at rest
with the gateway key, never put on chain, never shown again. Each bot gets webhook `/bots/telegram/<handle>`,
verified by its own `X-Telegram-Bot-Api-Secret-Token`; without a public URL the gateway uses long polling.

**Consequences.** Telegram is optional for "Create your shop"; the demo seller has its own bot.
