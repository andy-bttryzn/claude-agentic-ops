// Orchestrator: front-of-house Opus loop that dispatches Sonnet subagents in parallel.
//
// Pattern: independent ops queries (inbox triage, queue scans, portfolio walk) fan out
// as subagent calls. Main thread aggregates findings into one prioritized list and
// surfaces to the human operator.
//
// In production this lives in a Claude Code session; the orchestrator IS Claude itself,
// using the Agent SDK's task-dispatch primitive. Here we model the pattern with raw API
// calls so it's runnable as a standalone Node script.

import 'dotenv/config';
import { runSubagent } from './subagent_runner.js';
import { loadSops } from './sop_loader.js';

const SUBAGENTS = [
  {
    name: 'inbox-triage',
    description: 'Find oldest vendor-relevant inbound; render brief.',
    prompt: 'Walk the inbox queue oldest-first. For the top vendor-relevant thread, return: thread_id, vendor_canonical, brief_summary (3 lines), open_items_count, questions_for_andy.',
  },
  {
    name: 'task-queue',
    description: 'Pull stalest open task on the work board; surface context.',
    prompt: 'Pull the oldest open task on the work board (waiting-on filters applied). Return: task_id, name, last_touched_days_ago, vendor_canonical, recommended_action, questions_for_andy.',
  },
  {
    name: 'portfolio-walk',
    description: 'Bottom-up traversal of the vendor portfolio; surface forgotten items.',
    prompt: 'Run bottom-up traversal of the vendor portfolio (Dead → Other → Early Talks → Onboarding → Live). Return the next vendor and: name, group, opportunity_size, last_touched_days_ago, key_blockers.',
  },
];

async function main() {
  const sops = await loadSops('./sops');
  console.log(`Loaded ${sops.length} SOP rule files into system context.`);

  const results = await Promise.all(
    SUBAGENTS.map((cfg) =>
      runSubagent({
        name: cfg.name,
        prompt: cfg.prompt,
        systemContext: sops.map((s) => s.body).join('\n\n---\n\n'),
      }).catch((err) => ({ name: cfg.name, error: err.message })),
    ),
  );

  console.log('\n=== Aggregated findings ===\n');
  for (const r of results) {
    console.log(`## ${r.name}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
    } else {
      console.log(JSON.stringify(r.result, null, 2));
    }
    console.log();
  }
}

main().catch((err) => {
  console.error('orchestrator failed:', err);
  process.exit(1);
});
