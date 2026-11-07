# ADR 0024 — The safety check runs on drafts; a flagged draft is held, not removed; an AI post editor

Status: accepted (8 Nov 2026)

## Context
On 7 Nov the opportunity analyst suggested "Move client inquiries to a private Telegram channel … for direct
ordering" for a real store. The post writer followed it, and the moderator (ADR 0022) removed two of the three posts
at publish time as "payment outside escrow". The removals counted as violations (3 pause a store), the owner saw
"removed by moderation" on posts our own AI had written, and nothing told them what was happening when they pressed
Post. There was also no way to remake a picture, give the AI a free instruction, or skip a draft.

## Decision
- **Prompts**: the opportunity analyst, the post writer and the caption editor never suggest taking orders,
  payments or conversations off the store (DMs, private channels, invite links, phone, bank transfer). A "channel"
  opportunity is a place to share posts and the store link.
- **Check on drafts**: `check_post` (after every write, rewrite or new picture) also asks the moderator for a
  verdict, check-only (`market.precheck`: nothing removed, no violation). It is stored as `idea.safety`, tied to the
  caption hash and picture it judged.
- **Publishing**: a flagged draft can't be scheduled (409 `needs_change`). Just before going public the check runs
  again; a flagged post goes back to `ready` with the reason (`safety.held`), unpublished, with no violation. If the
  check is down, the post goes out and the full moderator looks a minute later (unchanged). Buyer reports and later
  checks still remove published posts and count violations (ADR 0022).
- **Post editor**: "Fix with AI" (caption-editor style `fix`, the reason comes from our check, never from the
  request), "Tell AI what to change" (style `custom`, 300 chars, as a data block), "New picture" (the same picture
  step, 1 picture credit, refunded on failure), "Skip this post" (status `skipped`, a "passed" signal for taste
  learning). Post now / Best time open a window that follows the post to Live ✓, Scheduled ✓ or "Needs a small
  change".

## Consequences
- One more moderator call (Kimi K2.6, ~10 s, ~$0.0007) per draft and per edit, and one at publish time.
- The prompt changes alter the replay keys of the opportunity analyst and post writer: `make demo` needs a re-record
  (`RECORD_DIR=fixtures/replay/store … node apps/worker/dist/content-cli.js`) before these changes are pushed.
- The violations of the 7 Nov posts were undone and the posts returned to drafts (admin note in `violations`).
