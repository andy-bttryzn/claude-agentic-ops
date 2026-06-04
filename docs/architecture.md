# Architecture

A reference architecture for a single-user, single-machine agentic ops system built on Claude Code. Production heritage: vendor management for a lead-gen marketplace, ~370 Node modules, ~424 SOP rule files, scheduled task fleet. This doc covers how the layers fit together; the individual `patterns/*.md` docs go deep on each piece.

## The shape

The single operator at the desk runs **Claude Code as the agent harness**. Behind it, three things make the agent durable:

1. **A tiered persistent memory layer** — the agent reads accumulated rules every session, doesn't relearn from scratch.
2. **A shared work feed** — every open task across the stack lives in one prioritized queue, claimed atomically so multiple sessions don't collide.
3. **A daemon layer** — long-running watchers (inbox poll, watchdog, periodic crons) handle the "while no one's looking" work and surface signals back into the cockpit.

The agent itself is the front-of-house. Heavy lifting fans out to background Sonnet subagents. Persistent state lives in flat files (jsonl + .md), under git for the memory dir and Drive sync for everything else.

```
                       [ operator ]
                            ↓
                      [ Claude Code ]
                       (Opus, harness)
                            ↓
        ┌───────────────────┼───────────────────┐
        ↓                   ↓                   ↓
  [ memory layer ]   [ work feed +       [ subagent dispatch ]
                       claim-lock ]       (parallel Sonnet)
        │                   │                   │
        └──────── shared file system ────────────┘
                            ↓
              [ daemon layer: watchers, crons ]
                            ↓
              [ external integrations via MCP +
                 direct API: Gmail, Drive, monday,
                 Airtable, Jira, lender platforms ]
```

## The lifecycle of a session

**SessionStart.** Hooks fire in declaration order. Three categories: context injectors (memory index, periodic state, last-touched markers), gates that block start under no circumstances, and side-effect loggers (telemetry, session count). Total combined target: under 2 seconds.

**Prompt.** Operator types a request. UserPromptSubmit hooks fire: timestamp injection, surfaced-action drainage (any "you have a parked decision" notes), per-prompt memory-refresh nudges. The agent reads the injected context plus the auto-loaded `MEMORY.md` + the hook-injected `MEMORY_reference.md`.

**Tool use.** The agent dispatches tool calls. PreToolUse hooks gate specific tool families: argv-check on Bash, em-dash lint on Write/Edit, ask-tracking after N tool calls without a parked-followup write. PostToolUse hooks log results (memory-access tracking, subagent results capture). Each guard hook returns a `decision: "block"` with a `reason` field if it rejects, never a silent block.

**Reply.** Stop hooks fire. These check for unverified state claims, unfinished background tasks, friction signals worth recording. Stop hooks NEVER block end-of-turn — they emit warnings the agent (or operator) can address on the next turn.

**SessionEnd.** Memory git push, optional Drive sync, session-end logging. No mandatory work; the session can end mid-task and resume cleanly on next start.

## The memory layer

Three loaded tiers + an archived tier (see `patterns/memory-hygiene.md`):

- **`MEMORY.md`** — auto-loaded by Claude Code. Cap ~24KB. Load-bearing rules + critical recent learnings. Index style — each entry is one line pointing at the topic file with a one-line hook.
- **`MEMORY_reference.md`** — auto-injected by a SessionStart hook (not native). The longitudinal index. ~30-40KB after disciplined trimming.
- **`MEMORY_project.md`** — auto-injected too. Currently-running initiatives, who's blocking what, decisions pending.
- **`MEMORY_reference_archived_*.md`** — grep-only. Not injected. Stale-but-historical rules that you might Read on demand.

Topic files (one rule per file) live in the same directory, named `feedback_*.md`, `reference_*.md`, `sop_*.md`, `project_*.md`. Each carries YAML frontmatter the SOP loader parses to put into system context when invoked.

## The work feed + claim lock

A daemon rebuilds `_work_feed.json` every 20 minutes. The feed unifies every open thing across the stack: oldest emails needing reply, stale monday tasks, staged drafts, AM handoffs.

Items are **tranche-ordered** (urgent → quick → medium → heavy → deep) and **oldest-first within each tranche**. The agent peeks the top unclaimed item, atomically writes a claim to `_work_feed.claims.json` (sidecar — not the feed itself, so rebuilds don't blow up claims). Claims have a 30-minute TTL. Other sessions get the next unclaimed item.

The sidecar pattern matters: claim ownership is metadata about the feed item, not the item itself. The feed can rebuild without losing active claims; the claims file can be rotated without losing the feed.

## The orchestration model

Two-layer:

- **Front-of-house** — the conversation with the operator. Opus model. Reads the operator's intent, decides the route, dispatches.
- **Back-of-house** — Sonnet subagents for the actual work. Each subagent is single-shot: takes a prompt, runs to completion, returns a structured JSON.

The pattern is in `src/orchestrator.js` + `src/subagent_runner.js`. Production uses Claude Code's native Agent tool for dispatch; the reference template uses raw `messages.create()` calls to keep portable.

Three parallel subagents at a time is the default ceiling. Past three, Cloudflare-style rate signals start showing up on the targets (Gmail API, monday GraphQL, lender platforms).

## The intelligence loop

Two daily crons (see `patterns/daily-intel-loop.md`):

- **06:30 — digest**. Scans verified sources for new features: API release notes, SDK GitHub releases, Anthropic engineering blog, optional T3 community sources. Hashes each source for dedupe. Summarizes via `claude -p`. Emails the operator.
- **06:45 — investigations**. Picks top N `Test candidate: YES` items from the digest, re-fetches each URL, runs a deeper structured prompt, writes a per-candidate report. Emails with one-line `TASK_FOR_ANDY:` action handoffs.

The system maintains itself. The operator never has to read changelogs to stay current with the platform.

## The security model

Five code-level invariants (see `patterns/security-invariants.md`):

1. **No shell command from scraped or LLM text** — argv array spawn only. `execSync(\`...${x}...\`)` is banned.
2. **Markdown → HTML goes through a sanitizer** — `safeMarkdown()` over raw `marked.parse()`.
3. **Filesystem paths from content go through `safeJoin` / `validJobId`** — path traversal blocked.
4. **Secrets get owner-only perms** — `chmod 0600`, NOT in a sync folder.
5. **OAuth `redirect_uri` pinned to loopback** — never derived from `Host` / `X-Forwarded-*`.

The model assumes the LLM **can** be prompt-injected. Defenses live at the host layer. Prompt-level mitigations are belt-and-suspenders, not load-bearing.

## The hooks layer

See `patterns/hooks-architecture.md`. Three categories that don't mix:

- **Context injectors** — SessionStart + UserPromptSubmit. Silent. Never block.
- **Guards** — PreToolUse. Block on specific input patterns. Reason field MUST be specific (name the input bit, name the bypass).
- **Side-effect / loggers** — PostToolUse + Stop + SubagentStop. Never block. Errors swallowed.

Per-project hooks live in `<project-root>/.claude/settings.json`. User-global hooks in `~/.claude/settings.json`. When you pivot projects, audit user-global for hardcoded old-project assumptions and move or remove.

## Where production diverges from this template

This repo is the reference template. The production system has additional layers the template doesn't ship:

- **CDP serialization** — a global atomic lock so two sessions never drive the same Chrome profile simultaneously. Lender platforms gate behind Cloudflare; concurrent CDP triggers an IP-level ban.
- **Voice corpus** — 4,000+ sent emails mined into a style profile. Every Claude-drafted outbound passes through a voice-calibration check before staging.
- **Multi-machine orchestration** — 3 machines + a Linux VM. Drive sync handles state mirroring. The reference template runs single-machine.
- **MCP fleet** — Gmail, Drive, monday, Airtable, Jira, Box, Phonexa wired as MCP servers. The template stubs the MCP wiring; the production wiring varies per platform.
- **Cockpit UI** — a local web view at `localhost:5174` showing the work feed + actions + briefs. Not in the template.
- **Skill library** — ~50 first-party skills (vendor-walk, old-inbox, EOM-returns, brief-render) that compose into named workflows. The template ships one example SOP file.

## Why no framework

The patterns in this repo are intentionally **lift-and-adapt**, not install-as-dependency. Production agentic-ops work is project-shaped: every team's monday board is different, every vendor base has different naming, every operator has a different voice. A framework that tried to abstract over those would impose its model and you'd spend more time wrestling the abstraction than the agent.

The patterns instead give you the load-bearing pieces:

- The shape of the persistent memory.
- The shape of the work feed.
- The shape of guard hooks.
- The shape of the intel loop.
- The shape of the security invariants.
- The shape of the chat-bridge surface.

Adapt each to your codebase. Don't pull this in as a dependency.

## Further reading

- `patterns/daily-intel-loop.md` — the self-maintaining intel pipeline
- `patterns/security-invariants.md` — the five code-level host-layer invariants
- `patterns/memory-hygiene.md` — three-layer memory loading + classifier-driven split
- `patterns/hooks-architecture.md` — composing hooks without trapping yourself
- `patterns/chat-bridge.md` — per-user Claude Code surfaced via Teams / Telegram / Slack
- `src/orchestrator.js` — runnable example of the front-of-house dispatch pattern
- `sops/example_vendor_onboarding.md` — annotated example SOP file with frontmatter conventions
