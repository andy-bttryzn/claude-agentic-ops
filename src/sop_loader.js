// SOP loader: reads .md files from a directory, parses YAML frontmatter, returns
// a list of { name, type, description, body }.
//
// The pattern: each SOP is a single source-of-truth document with a tight one-line
// description (used to decide relevance), a type tag, and a body that the agent
// loads as system context. The agent reasons about org policy by reading these.
//
// Production system has 424 of these. This template ships one example.

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

export async function loadSops(dir) {
  const files = await readdir(dir);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const raw = await readFile(join(dir, f), 'utf8');
    const parsed = parseFrontmatter(raw);
    out.push({ file: f, ...parsed });
  }
  return out;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!m) return { name: '', type: 'unknown', description: '', body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return {
    name: meta.name || '',
    type: meta.type || 'unknown',
    description: meta.description || '',
    body: m[2].trim(),
  };
}
