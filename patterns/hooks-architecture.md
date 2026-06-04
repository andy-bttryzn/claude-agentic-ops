# Claude Code Hooks Architecture

A production agentic-ops stack runs a dozen-plus hooks across the Claude Code event lifecycle: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, Notification, PreCompact. This doc covers the pattern for composing them without trapping yourself in a forest of brittle gates.

## What hooks actually are

A hook is a shell command the harness invokes at a specific event. It reads a JSON event payload on stdin, optionally writes a JSON response on stdout, and exits. Exit code 2 = block the operation.

Configuration lives in `~/.claude/settings.json` under `hooks.<EventName>[]`. Each entry has an optional `matcher` (regex on tool name) and one or more `hooks` (commands to run).

## The categories that hold up

Across a real stack, hooks fall into three roles. Mixing them in one matcher creates accidental coupling.

### 1. Context injection — quietly augment what the agent sees

Examples: timestamp injection, memory index injection, current-state surfacing.

```json
{
  "matcher": "",
  "hooks": [{
    "type": "command",
    "command": "node hooks/inject-memory-reference.cjs",
    "timeout": 5
  }]
}
```

Pattern: hook reads from disk, emits `hookSpecificOutput.additionalContext` on stdout, exits 0. Always silent on missing files. Never blocks (exit 0 even on error).

Risk if it errors: agent loses the context. Acceptable degradation.

### 2. Guard / lint — block bad-pattern actions

Examples: em-dash check in drafts, untracked-ask gate, secret-perm verifier, deterministic-block-before-retry guard.

```json
{
  "matcher": "Write|Edit",
  "hooks": [{
    "type": "command",
    "command": "node hooks/check-em-dash.cjs",
    "timeout": 10
  }]
}
```

Pattern: hook reads `tool_input` from the event payload, checks the proposed change against a rule, emits `decision: "block"` with a clear `reason` on stdout (or just exits 2) if the rule fails. Otherwise exits 0 silently.

Risk if it errors: false-positive blocks legit work. Mitigation: every guard has a documented bypass (per-call `--skip-X` flag, or a `<!-- bypass-ok -->` marker in content, both surfacing in `_guard_bypass_log.jsonl` for audit).

### 3. Side-effect / log — fire after the fact, never block

Examples: telemetry capture, memory-access audit, friction-signal append, subagent-completion record.

```json
{
  "matcher": "",
  "hooks": [{
    "type": "command",
    "command": "node hooks/friction-detection.cjs",
    "timeout": 15
  }]
}
```

Pattern: hook reads the event payload, writes to a log/state file, exits 0. Never blocks. Errors are swallowed so a flaky telemetry path doesn't break the workflow.

## The trap: mixing category 1 + 2

A common mistake: a SessionStart hook that "checks that today's prep is done" before injecting context. If the check fails, it blocks SessionStart entirely, locking the operator out of every new session.

**Discipline**: category 2 (guards) NEVER live in SessionStart. They live on PreToolUse against the specific action they want to gate. SessionStart is category 1 (context injection) only.

## Per-project vs. user-global hooks

`~/.claude/settings.json` applies to every Claude Code session on the machine. A guard hook with hardcoded project assumptions (a specific monday board ID, a specific Gmail label semantics) will fire — and possibly false-positive — in unrelated projects.

**Discipline**:
- Universal guards (em-dash check, secret perms, generic ask-tracking) live in user-global settings.
- Project-specific guards (label semantics, vendor board hookups) live in the per-project `.claude/settings.json` at that project's root.
- When you pivot off a project, audit user-global settings for hooks that still hardcode the old project's assumptions. Move or remove.

## Composing many hooks under one event

Multiple hooks under the same event fire in declaration order. Their exit codes are or'd — if any one blocks, the operation blocks.

```json
"Stop": [
  { "hooks": [{ "type": "command", "command": "node hook-A.cjs" }] },
  { "hooks": [{ "type": "command", "command": "node hook-B.cjs" }] },
  { "hooks": [{ "type": "command", "command": "node hook-C.cjs" }] }
]
```

Pattern: each hook is independent. Order doesn't matter for correctness, only for which-error-the-operator-sees-first when two fire simultaneously.

**Anti-pattern**: hook B reads state hook A wrote earlier in the same event. The harness doesn't guarantee A finishes before B starts. State coupling between hooks under the same event is racy.

## The "block-then-retry-without-change" trap

When a guard blocks an action, the agent sees the block reason and decides whether to fix the input or just retry. A poorly-written guard reason ("This action is not allowed") leads to deterministic-block-without-change loops — the agent retries the same action, gets the same block, retries again.

**Discipline**:
- Block reasons MUST name the specific input bit that caused the block (`"em-dash detected at position 47"`, not `"writing style violation"`).
- The reason MUST tell the agent how to bypass (`"add <!-- bypass-ok: $REASON -->"` or `"pass --skip-em-dash"`).
- After two repeated identical blocks, suspect a stuck-retry loop and surface to the operator.

## Hook performance

Every event fires every applicable hook. SessionStart with 5 hooks at 5s timeout each = 25s of potential delay at session start. UserPromptSubmit fires on every prompt.

**Targets**:
- SessionStart: < 2s combined
- UserPromptSubmit: < 500ms combined
- PreToolUse: < 1s per hook
- Stop: < 5s combined

Hooks exceeding these targets get logged + their timeout halved on next session, until either they get faster or they get removed.

## Audit cadence

Quarterly:
- Run an empty session, time each hook's contribution to SessionStart. Drop any that exceed their target.
- Grep guard reasons for vague language. Replace with specific input citation.
- Check `_guard_bypass_log.jsonl` for guards that get bypassed > 50% of the time. Either the guard is too strict, or the bypass criteria need to be a real exception path in the guard logic.

Per-project pivot:
- When you stop work on a project, audit user-global hooks for hardcoded project IDs / vendor names / label semantics. Remove or move to per-project.
- The pivot is the only good time to do this — once you're past it, the false-positive blocks become someone-else's-problem noise.

## Anti-pattern: silent guards

A guard that exits 0 with no stdout is invisible to the operator. A guard that exits 2 with no `reason` field surfaces a generic "blocked" message and confuses the agent into a retry loop.

**Always emit reason on block**:
```js
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: 'em-dash detected at position 47 — replace with ", " or " — "',
}));
process.exit(2);
```

The agent reads `reason`, knows what to change, doesn't retry blindly.
