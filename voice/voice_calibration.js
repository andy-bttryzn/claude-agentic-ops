// Voice calibration scaffold: extract style features from a sent-mail JSON corpus.
//
// In production this runs across thousands of historical messages and builds a
// system-prompt block that pins AI-drafted outbound to the user's natural register.
// Here we ship a stub that takes a small sample JSON and emits a feature summary
// so the pattern is portable.
//
// Usage:
//   node voice/voice_calibration.js voice/sample_corpus.json

import { readFile } from 'fs/promises';

const BANNED_LLM_TELLS = [
  'leverage',
  'robust',
  'delve',
  'endeavor',
  'facilitate',
  'synergy',
  'incentivize',
  'circle back',
  'touch base',
  'going forward',
  'moving forward',
];

async function main(path) {
  const raw = await readFile(path, 'utf8');
  const corpus = JSON.parse(raw);

  const features = {
    message_count: corpus.length,
    avg_word_count: avg(corpus.map((m) => wordCount(m.body))),
    avg_sentence_count: avg(corpus.map((m) => sentenceCount(m.body))),
    greetings: topN(
      corpus
        .map((m) => firstLine(m.body))
        .filter(Boolean),
      8,
    ),
    closings: topN(
      corpus
        .map((m) => closingLine(m.body))
        .filter(Boolean),
      6,
    ),
    contraction_rate: rate(corpus, /\b(\w+'(s|t|re|ve|ll|d|m))\b/i),
    em_dash_rate: rate(corpus, /—/),
    semicolon_rate: rate(corpus, /;/),
    banned_phrase_hits: BANNED_LLM_TELLS.map((p) => ({
      phrase: p,
      hits: corpus.filter((m) => new RegExp(`\\b${p}\\b`, 'i').test(m.body)).length,
    })).filter((x) => x.hits > 0),
  };

  console.log(JSON.stringify(features, null, 2));

  console.log('\n--- Voice rule prompt suggestion ---\n');
  console.log(promptFromFeatures(features));
}

function wordCount(s) {
  return (s.match(/\b\w+\b/g) || []).length;
}

function sentenceCount(s) {
  return (s.match(/[.!?]+\s|\n\n/g) || []).length || 1;
}

function avg(arr) {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function rate(corpus, re) {
  const hits = corpus.filter((m) => re.test(m.body)).length;
  return corpus.length ? +(hits / corpus.length).toFixed(3) : 0;
}

function firstLine(s) {
  return (s.split(/\n/)[0] || '').trim();
}

function closingLine(s) {
  const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  return lines[lines.length - 2];
}

function topN(items, n) {
  const counts = new Map();
  for (const i of items) counts.set(i, (counts.get(i) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function promptFromFeatures(f) {
  const lines = [
    `Average length: ${f.avg_word_count} words across ~${f.avg_sentence_count} sentences.`,
    `Common greetings (most → least): ${f.greetings.map(([g]) => g).slice(0, 3).join(' / ')}.`,
    `Common closings (most → least): ${f.closings.map(([g]) => g).slice(0, 3).join(' / ')}.`,
    f.em_dash_rate > 0
      ? `Em-dash rate: ${f.em_dash_rate} (treat as low; avoid em-dashes in output).`
      : 'Em-dash rate: 0 (do not introduce em-dashes).',
    f.banned_phrase_hits.length === 0
      ? 'No banned LLM-tell phrases in corpus. Hold the line.'
      : `Banned phrase hits to avoid: ${f.banned_phrase_hits.map((b) => b.phrase).join(', ')}.`,
  ];
  return lines.join('\n');
}

const path = process.argv[2] || 'voice/sample_corpus.json';
main(path).catch((err) => {
  console.error('voice calibration failed:', err.message);
  process.exit(1);
});
