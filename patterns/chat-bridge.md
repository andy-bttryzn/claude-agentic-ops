# Chat Bridge: per-user Claude Code, surfaced in Teams / Telegram

A pattern for deploying agentic-ops to teams who don't want a terminal. Each user has their own Claude Code session running on their own credentials; the surface they actually touch is the chat app they already use daily — Microsoft Teams, Telegram, or Slack. A thin bridge translates inbound chat messages into Claude Code invocations and posts the responses back as chat replies.

## Threat / problem it solves

The CLI is the natural surface for Claude Code, but it's a non-starter for most non-engineering teammates. Asking a sales lead, an ops admin, or a partner manager to install Node and learn `claude -p` is a deal-killer. Meanwhile, those users already live in Teams or Telegram. Meeting them in the chat tool they're already in collapses the adoption barrier from "weeks of training" to "you have a new contact in Teams, talk to them."

The mistake some teams make is to swap the CLI for a single shared backend agent ("one bot, many users"). That destroys per-user attribution (whose action sent the email?), forces multi-tenant infra (auth, isolation, billing per user), and loses the per-user memory that's the whole point of an agent that learns its operator.

This pattern keeps the per-user CLI architecture intact and adds a chat surface on top.

## Architecture

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Microsoft Teams  /  Telegram  /  Slack  (whatever they use) │
  └─────────────────────────────┬────────────────────────────────┘
                                │  inbound msg
                                ▼
                  ┌──────────────────────────┐
                  │   chat bridge process    │
                  │  - resolve chat_id → user│
                  │  - lookup user's CLI dir │
                  │  - dispatch claude -p    │
                  │  - stream output back    │
                  └──────────┬───────────────┘
                             │  spawn / pipe
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
       ┌────────┐       ┌────────┐           ┌────────┐
       │  CC    │       │  CC    │           │  CC    │
       │ alice  │       │  bob   │   ...     │ carol  │
       └────────┘       └────────┘           └────────┘
       (her creds)      (his creds)          (her creds)
       (her memory)     (his memory)         (her memory)
```

Single bridge process, many per-user Claude Code instances. Each instance has its own credentials, its own memory directory, its own work feed — full isolation. The bridge owns nothing except the chat_id → user_dir mapping.

## Per-user routing

The bridge keeps a small config:

```yaml
# users.yaml
users:
  - chat_id: 8412309876        # Telegram user id (or Teams AAD object id)
    user_handle: alice
    claude_dir: /var/agentic/users/alice
  - chat_id: 4920018844
    user_handle: bob
    claude_dir: /var/agentic/users/bob
```

Inbound message → look up `chat_id` → `claude_dir` → spawn `claude -p` with `cwd: claude_dir`. The CLI auto-loads that user's memory + session state from their dir, so each conversation continues their own thread.

Unknown chat_id → reply with onboarding message + log for admin attention. Never auto-create users; that's an admin action.

## Streaming responses

Claude Code can take seconds to minutes per turn. Three options for surfacing progress:

1. **Stream chunks as edits to a single message.** Most chat APIs allow `editMessage(msgId, newText)`. Bridge starts with "thinking…", then edits the message as the agent streams. Cleanest UX, but rate limits matter (Telegram is ~30 edits/min per chat).
2. **Post tool-use milestones as separate messages.** Each tool call produces a one-line update ("checking monday…", "drafting reply…"). Higher noise but clearer progress.
3. **Single final message.** No streaming. Bridge buffers until done, posts the whole thing. Simplest. Use for short tasks; UX degrades past ~10s.

Default: option 1 for prose, option 2 if the agent runs multi-step tool chains > 15s.

## Per-platform notes

### Telegram

Simpler. The Bot API is HTTPS, no SDK required. One token, one webhook. The bot can DM individual users or be added to a group; per-user routing works in both modes (use `from.id`, not `chat.id`, in groups).

Reference: `node-telegram-bot-api` or raw `fetch` against `api.telegram.org/bot<TOKEN>/sendMessage`.

### Microsoft Teams

More involved. Needs the Bot Framework SDK + an Azure Bot Service registration + an Entra ID (Azure AD) app. The user identifier is the `from.aadObjectId`, which is stable across DMs and channel conversations. Adaptive Cards work natively if you want rich responses with buttons.

Reference: `botbuilder` (Node) or `botbuilder-python`.

### Slack

Between the two on complexity. Slack's Bolt SDK handles the boilerplate. `user.id` is the routing key.

## Per-user account credentials

Each per-user Claude Code instance authenticates to whatever downstream services that user needs (Gmail, monday, etc.) under that user's own credentials. The bridge does NOT proxy credentials — it only routes messages. This keeps:

- Audit trails accurate (the email sent under alice's tokens is attributable to alice)
- Permission scope honest (bob can't accidentally act with carol's monday seat)
- Token refresh local to each user's CLI dir

If the chat app's identity provider (Entra, Google Workspace) is the same as the downstream services, you can wire SSO so bridge-side onboarding auto-provisions the per-user CLI. Otherwise, a one-time per-user OAuth dance is required at provisioning time.

## Gotchas

- **Don't share memory across users.** Each user dir has its own memory. A "shared memory" temptation looks elegant but kills per-user voice calibration and creates conflict-resolution problems on simultaneous writes.
- **One CLI instance per user, not per message.** Spawning a fresh `claude -p` per inbound message is fine for stateless one-shots but loses conversational context. For conversational continuity, run a persistent `claude` session per user and pipe messages over stdin (or use the SDK).
- **Rate limit per user, not globally.** A noisy user shouldn't slow down other users' replies. Bridge maintains per-user queues.
- **Failure mode visibility.** If the bridge can't reach the per-user CLI, the user gets a fallback message in chat ("can't reach your assistant right now, admin notified"). Silent timeouts erode trust.

## When NOT to use this pattern

- **One operator only** (Andy's original production stack). The chat surface adds latency + complexity. The terminal is better.
- **Genuinely shared workflows** where one agent serves a queue (e.g. customer support triage). A single backend with per-conversation context is the right shape.
- **Compliance-restricted environments** where chat-app message storage policies conflict with the agent's data handling. Audit the chat platform's retention before bridging.

## Further reading

- `daily-intel-loop.md` — the always-on intel piece that runs server-side regardless of chat surface
- `security-invariants.md` — input from chat surface must be treated as untrusted text, same guarantees as scraped content
- `memory-hygiene.md` — per-user memory dirs follow the same three-tier loading pattern as single-user
