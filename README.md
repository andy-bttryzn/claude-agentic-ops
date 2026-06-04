# claude-agentic-ops

A reference template for orchestrating parallel Claude Sonnet subagents inside a Node.js operations pipeline. Patterns extracted from a production agentic-ops system that runs vendor management for a lead-gen marketplace.

This is the architecture pattern, not the production code. The production system is private. Everything here is generic, runnable, and designed to be adapted.

## What this shows

- **Subagent dispatch**: how to fan out independent ops queries (inbox triage, queue scans, portfolio walks) to parallel Sonnet subagents and aggregate findings into one prioritized list.
- **MCP server wiring**: connecting Anthropic's Model Context Protocol servers (Gmail, Drive, monday.com, Airtable) to the Claude SDK client so the agent has first-class access to operational systems.
- **SOP-as-context**: loading machine-readable rule files (`.md` with YAML frontmatter) as structured system context so the agent reasons about vendor policy the way a trained operator would.
- **Voice calibration scaffold**: a stub for mining a sent-mail corpus to extract style features that keep AI-drafted outbound consistent with a specific owner's register.

## Why this matters

Most agent demos are single-shot. Production ops work is multi-shot, parallel, and durable. The patterns here address the gap: how do you give an agent enough context to make good ops decisions, dispatch enough work in parallel to actually save time, and keep its output sounding like the human it's working for.

## Quick start

```bash
git clone https://github.com/andy-bttryzn/claude-agentic-ops.git
cd claude-agentic-ops
npm install
cp .env.example .env  # add your ANTHROPIC_API_KEY
node src/orchestrator.js  # runs the example multi-agent flow
```

## Layout

```
claude-agentic-ops/
├── README.md
├── package.json
├── .env.example
├── src/
│   ├── orchestrator.js       # Main loop. Dispatches Sonnet subagents in parallel.
│   ├── subagent_runner.js    # Generic subagent wrapper. Single-shot, structured return.
│   ├── mcp_wiring.js         # MCP server client setup for Gmail / Drive / monday / Airtable.
│   └── sop_loader.js         # Loads .md rule files into the system-context block.
├── sops/
│   └── example_vendor_onboarding.md   # Annotated SOP file. Frontmatter + body conventions.
├── voice/
│   └── voice_calibration.js  # Corpus-mining stub. Extracts style features from sent-mail JSON.
└── patterns/
    ├── daily-intel-loop.md       # Self-maintaining intel pipeline. Daily digest + investigations crons.
    └── security-invariants.md    # Five code-level invariants for agents touching untrusted content.
```

## Patterns

Standalone architectural pattern docs in `patterns/` — each describes one piece of the production system in enough depth to lift into a different codebase.

- **`patterns/daily-intel-loop.md`** — Self-maintaining intel pipeline: daily digest cron scans verified sources (SDK changelogs, GH releases, engineering blog) for new features and patterns, summarizes via `claude -p`, emails findings. A follow-up investigations cron deep-dives top candidates and emails per-item adoption recommendations with one-line action handoffs.
- **`patterns/security-invariants.md`** — Five code-level invariants for an agent stack handling untrusted content (Gmail bodies, scraped pages, LLM output) while holding OAuth tokens. Adapted from the RoleScout `SECURITY.md` model. Assumes the LLM *can* be prompt-injected and hardens the host system around it.

## What this is not

- Not a framework. Adapt the patterns; don't try to install this as a dependency.
- Not a complete ops system. The production system has 370+ modules and 424 SOP files. This shows the foundations.
- Not a prompt-engineering tutorial. Assumes familiarity with Claude API and the Agent SDK.

## License

MIT. Use it however you want.
