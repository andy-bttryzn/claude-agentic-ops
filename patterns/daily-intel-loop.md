# Daily Intel Loop

A self-maintaining intel pipeline that scans verified sources for new features / patterns relevant to a codebase, surfaces them as actionable items, and (optionally) auto-investigates top candidates.

Implemented as two scheduled tasks (Windows Task Scheduler / cron) running ~15 min apart, daily.

## Threat / problem it solves

Production agentic stacks drift behind the underlying tool/SDK changelog. Most teams find out about a useful capability weeks late. Manual changelog reading doesn't survive contact with a busy operator. The intel loop replaces "I should check the Anthropic blog" with "the digest already told me, and here's the A/B vs current pattern."

## Architecture (two crons, dedupe, send)

```
06:30 daily ─── intel_digest.cjs ─────► email "Intel digest YYMMDD"
                  │                       │
                  │ updates _intel_seen   │
                  ▼                       │
            (sources/* fetched)           │
                                          │
06:45 daily ─── intel_investigations ────► email "Intel investigations YYMMDD"
                  │                       │  (per-candidate TASK_FOR_ANDY lines)
                  │ reads today's digest
                  │ picks top N candidates
                  │ deep-dives each via claude -p
                  ▼
            reports/* cached for grep
```

## Source tiers

- **T1 — Official** (mandatory): SDK release notes, docs changelog, official news page, GH releases on the org's repos
- **T2 — Authored signal**: engineering blog, conference talks the maintainers gave
- **T3 — Community** (opt-in): subreddit top-week, YouTube channel uploads, GH trending under the topic tag

Default T1 + T2. Opt T3 in once you've tuned T1/T2 noise.

## Dedupe via content hash

Every source's text is SHA256-hashed. Hash stored in `_intel_seen.jsonl` keyed by source. Next run skips unchanged sources. Avoids re-summarizing yesterday's news. Expires after N days so genuinely re-trending content can re-surface.

## Summarization (via `claude -p`)

For each source with new content, run a structured prompt:

```
You are a focused intelligence analyst. Below is content from "<source name>".
For each NEW feature / workflow pattern / developer-facing change, output:

### <short headline>
- URL: <direct link>
- What: <one sentence>
- Why interesting: <one sentence for a power user>
- Test candidate: YES / NO

If nothing new, output exactly: NONE
```

Result: structured findings, every claim tied to a URL the operator can verify.

## Verified-only

Every claim in the digest carries a canonical URL. If a finding can't be traced to a URL on a tier-1 or tier-2 source, it doesn't make the digest. No "according to a tweet I saw" rumors.

## Investigations pass (the v2 loop)

After the digest sends, a second cron picks the top N `Test candidate: YES` items and runs a deeper investigation prompt against fresh-fetched content from each URL:

- What it actually does (2-4 sentences, concrete behavior)
- How it would integrate with the stack (files / config / dependencies)
- A/B comparison vs current pattern (with vs without)
- Recommendation: ADOPT NOW / ADOPT LATER / WATCH / SKIP
- One-line `TASK_FOR_ANDY:` action — thumbs-up means one specific concrete action, thumbs-down means a different one

Operator reads the email, marks thumbs-up or thumbs-down, and the loop owns the rest. Tasks never get lost in a "I'll get to that someday" pile because the investigation is already done.

## Why the split into two crons

The digest is quick — fetch + summarize, ~2 min. The investigations need to fetch fresh URL content, run a longer prompt per item, and compose a follow-up email. Splitting them lets the digest land first (cheap, predictable), and the investigations follow ~15 min later (heavier, can fail without blocking the headline). Failures in v2 don't bury v1.

## Cost envelope

At full T1+T2+T3 with claude-sonnet-4-6 summarization:
- ~10 sources × ~3K tokens in × ~$0.003/1K = $0.03/day for digest
- ~3 investigations × ~5K tokens × ~$0.015/1K = $0.05/day for investigations

Negligible. The risk isn't cost — it's noise. Start narrow, widen once you trust the signal.

## State files

- `_intel_seen.jsonl` — content hashes for dedupe
- `_intel_log.jsonl` — run audit (sources scanned, findings, send status)
- `_intel_raw/` — cached fetched content (last run only; not historical)
- `_intel_investigations/<yymmdd>_<slug>.md` — investigation reports (permanent)

## Generalizing to a non-Claude codebase

The pattern is independent of Claude — substitute any LLM for the summarization step. Source list is where you specialize:

- Python ML stack → arXiv recent abstracts in your area, PyTorch release notes, HF model hub
- Database team → Postgres release notes, pg-hackers mailing list digest, official extension repos
- Frontend → MDN updates, framework release notes, Lighthouse / Core Web Vitals announcements

The verified-URL discipline carries across.

## Pitfalls observed

- **Source pages render via JS**: plain HTTP fetch returns empty body. Workaround: use Playwright for sources that need JS render (most modern doc sites do not, but some marketing pages do).
- **Rate limiting on GitHub releases API**: without auth, 60 req/hr. Cache aggressively or use a PAT for unauthenticated higher limits.
- **LLM hedge fluff**: structure the prompt to ban "this feature seems to..." / "may be useful for..." patterns. Demand concrete actionable verdict or NONE.
- **Stale findings re-surface as new**: hash-based dedupe survives this, but a page that re-renders nav menus differently can hash-mismatch even when content is identical. Strip nav/header/footer before hashing.
