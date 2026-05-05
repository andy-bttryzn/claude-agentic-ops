// Generic subagent wrapper. Single-shot Sonnet call with a structured-return prompt.
//
// In production the agent SDK exposes a task-spawn primitive that handles this; here
// we model it with a raw messages.create() call so the pattern is portable.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL_SONNET || 'claude-sonnet-4-6';

export async function runSubagent({ name, prompt, systemContext }) {
  const system =
    'You are a single-shot ops subagent. Respond with a JSON object only. ' +
    'No prose outside the JSON. Keep the response under 200 tokens.\n\n' +
    (systemContext ? `Operational rules:\n${systemContext}` : '');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content.map((block) => block.text || '').join('').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text, parse_error: true };
  }

  return { name, result: parsed };
}
