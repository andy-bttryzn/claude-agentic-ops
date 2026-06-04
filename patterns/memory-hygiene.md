# Tiered Memory Hygiene

A persistent memory dir (Claude Code's `~/.claude/projects/<slug>/memory/`) is the agent's institutional knowledge layer — every rule, voice preference, vendor convention, gotcha. Left unmanaged, it grows past the context budget. Tiered loading + a classifier-driven split keep the load-bearing rules auto-injected while archived rules stay grep-reachable.

## The problem

Claude Code auto-loads `MEMORY.md` at session start. The default size cap is around 24KB. Past that, the harness silently truncates and you lose the tail.

For a production ops stack, you accumulate ~600+ rule files inside a year. Two pressures: keep the index under the cap, **and** keep the index actually useful (not 200 lines of "well-known rule" noise that bloats the budget without driving behavior).

## The pattern (three layers)

```
MEMORY.md                                  — auto-loaded by Claude Code (24KB cap)
   ↑ load-bearing rules + critical recent learnings
   ↑ ~30-50 entries, alphabetically sorted within sections

MEMORY_reference.md                        — auto-injected by SessionStart hook
   ↑ longitudinal index, ~100-200 stable entries
   ↑ NOT loaded by Claude Code natively — the hook reads it and emits
     additionalContext at session start

MEMORY_reference_archived_*.md             — grep-only, not auto-injected
   ↑ stale-but-load-bearing-historical rules
   ↑ retrieval via Read + grep when actively needed
```

## SessionStart hook (additional context injection)

```js
// inject-memory-reference.cjs (SessionStart hook)
const refBody = safeRead(path.join(MEMORY_DIR, 'MEMORY_reference.md'));
if (refBody && refBody.trim()) {
  // Emit additionalContext so Claude sees the index even though it's not MEMORY.md
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '# MEMORY_reference.md\n\n' + refBody,
    },
  }));
}
```

The hook is silent on missing files, and includes a 100KB total cap with truncation-to-line-boundary to prevent runaway injection.

## Splitting via regex classifier

When you decide to retire a class of rules (say, all rules referencing a deprecated platform), run a classifier pass. The pattern that holds up in practice:

```js
const ARCHIVE_RE = [
  // Strong signals — rule references a fully retired system
  /old-system-name|old-board-id-\d+|deprecated-tool/i,
  // Specific vendor / customer names from the retired era
  /\bDeadVendorOne\b|\bDeadVendorTwo\b/,
  // Old workflow mechanics
  /old-workflow-keyword|legacy-pipeline-name/i,
];

const KEEP_RE = [
  // Universal infra
  /scheduled task|git index|drive sync|oauth/i,
  // Active products
  /\bBTTRYZN\b|\bUSRS\b|claude-agentic-ops/i,
  // Voice / lint / quality rules (era-independent)
  /writing style|em[- ]?dash|llm-tell|verify state|capped search/i,
];

// REVIEW = neither clear archive nor clear keep
```

Three buckets: **KEEP** (universal, definitely stays auto-injected), **ARCHIVE** (clear hits on retirement signals), **REVIEW** (ambiguous — needs eyes).

## Conservative vs. aggressive cuts

Two-pass discipline:
- **First pass — conservative**: only archive confident ARCHIVE hits. KEEP + REVIEW stay loaded. Captures the obvious 40-50% reduction without losing any borderline rule.
- **Second pass — aggressive**: re-run with broader ARCHIVE regexes after a few days of using the conservative cut. The borderline rules you've actually never re-used become archive-able.

Both passes write a `.preSplit-<yymmdd>` backup before mutating so the operator can roll back any single move.

## Why not just delete?

Deleted rules are gone. Archived rules are still grep-reachable:

```bash
grep -lir "deprecated-tool" ~/.claude/projects/.../memory/
# Finds the rule in MEMORY_reference_archived_*.md even though it's no longer auto-loaded
```

When a problem you thought was retired comes back, the rule is still there to consult or restore. The cost is one Read + maybe a manual line-move to bring it back into the auto-injected index.

## Measured outcome

Real session: `MEMORY_reference.md` 79KB → 34KB across two split passes. ~57% reduction in session-start injection. The 45KB freed gets spent on actual work content instead of stale rules. Tested by re-running a complex multi-agent flow on the trimmed memory; no missed rule signal.

## Pitfalls

- **Section header drift**: when you move entries between files, preserve the section headers in both places. Search-by-section is how operators find rules.
- **Wiki-link `[[name]]` rot**: rules cross-reference each other. Moving an entry to archive doesn't update the references in entries that stayed. Periodically grep for unresolved `[[]]` references and either fix or accept as known stale.
- **Hook truncation silently breaks tail rules**: if the SessionStart hook hits the 100KB cap and truncates, the tail-most rules silently stop loading. Make truncation visible to the operator (append a `[... truncated]` marker, log to stderr).
- **Regex over-archiving**: a single broad pattern that catches the platform name will sweep universal rules that happen to mention the platform once. Layer KEEP regexes that win over ARCHIVE for an entry that matches both.
