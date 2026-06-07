// chat_bridge_slack.test.js — sanity tests for the Slack bridge YAML parser.
//
// Mirrors the Telegram + Teams test structure. Routing key is slack_user_id
// (e.g. "U0123ABCD"). Verifies multi-surface users (chat_id + aad_object_id +
// slack_user_id on the same row) flow cleanly to the Slack bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function loadUsersForSlack(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const users = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.match(/^\s*-\s+/)) {
      if (cur) users.push(cur);
      cur = {};
    }
    if (!cur) continue;
    const kv = line.match(/^\s*(?:-\s+)?(\w+):\s*(.+?)\s*$/);
    if (kv) cur[kv[1]] = kv[2];
  }
  if (cur && Object.keys(cur).length) users.push(cur);
  return users.filter(u => u.slack_user_id);
}

function writeTmpYaml(content) {
  const tmp = path.join(os.tmpdir(), `users_slack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.yaml`);
  fs.writeFileSync(tmp, content);
  return tmp;
}

test('parses Slack-only user', () => {
  const yaml = `users:
  - user_handle: dave
    slack_user_id: U0DAVE123
    claude_dir: /tmp/dave
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForSlack(tmp);
    assert.equal(users.length, 1);
    assert.equal(users[0].slack_user_id, 'U0DAVE123');
  } finally { fs.unlinkSync(tmp); }
});

test('skips users without slack_user_id', () => {
  const yaml = `users:
  - user_handle: alice
    chat_id: 8412309876
    claude_dir: /tmp/alice
  - user_handle: bob
    aad_object_id: 5e8f2a01-3c4d-4b9a-b7f1-1a2b3c4d5e6f
    claude_dir: /tmp/bob
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForSlack(tmp);
    assert.equal(users.length, 0);
  } finally { fs.unlinkSync(tmp); }
});

test('parses repo users.example.yaml — Slack bridge sees carol + dave', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const examplePath = path.join(repoRoot, 'users.example.yaml');
  if (!fs.existsSync(examplePath)) {
    assert.fail(`users.example.yaml missing at ${examplePath}`);
  }
  const users = loadUsersForSlack(examplePath);
  assert.equal(users.length, 2);
  const handles = users.map(u => u.user_handle).sort();
  assert.deepEqual(handles, ['carol', 'dave']);
});

test('Slack-id Map lookup matches by exact string', () => {
  const yaml = `users:
  - user_handle: dave
    slack_user_id: U0DAVE123
    claude_dir: /tmp/dave
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForSlack(tmp);
    const bySlackId = new Map(users.map(u => [String(u.slack_user_id), u]));
    const matched = bySlackId.get('U0DAVE123');
    assert.ok(matched);
    assert.equal(matched.user_handle, 'dave');
    // Slack user ids are case-sensitive — lookup must match exact case
    assert.equal(bySlackId.get('u0dave123'), undefined);
  } finally { fs.unlinkSync(tmp); }
});
