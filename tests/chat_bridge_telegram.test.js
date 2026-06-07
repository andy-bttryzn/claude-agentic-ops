// chat_bridge_telegram.test.js — sanity tests for the bridge scaffold.
//
// Uses node:test (built-in, no deps). Run: node --test tests/chat_bridge_telegram.test.js
//
// Tests focus on the parts that can break silently without showing up at runtime:
// users.yaml parsing, chat_id resolution, dispatch path handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirror the parser from chat_bridge_telegram.js. Kept in sync by hand —
// production would extract to a shared module and import here.
function loadUsers(filePath) {
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
  return users
    .filter(u => u.chat_id !== undefined)
    .map(u => ({ ...u, chat_id: Number(u.chat_id) }));
}

function writeTmpYaml(content) {
  const tmp = path.join(os.tmpdir(), `users_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.yaml`);
  fs.writeFileSync(tmp, content);
  return tmp;
}

test('parses a 3-user config', () => {
  const yaml = `users:
  - chat_id: 100
    user_handle: alice
    claude_dir: /tmp/alice
  - chat_id: 200
    user_handle: bob
    claude_dir: /tmp/bob
  - chat_id: 300
    user_handle: carol
    claude_dir: /tmp/carol
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsers(tmp);
    assert.equal(users.length, 3);
    assert.equal(users[0].chat_id, 100);
    assert.equal(users[0].user_handle, 'alice');
    assert.equal(users[0].claude_dir, '/tmp/alice');
    assert.equal(users[2].chat_id, 300);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('chat_id is parsed as Number, not string', () => {
  // This matters because Telegram passes chat_id as an integer in the JSON;
  // a string-keyed map lookup would silently miss the match.
  const tmp = writeTmpYaml(`users:\n  - chat_id: 42\n    user_handle: x\n    claude_dir: /tmp/x\n`);
  try {
    const users = loadUsers(tmp);
    assert.equal(typeof users[0].chat_id, 'number');
    assert.equal(users[0].chat_id, 42);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('empty config returns empty array', () => {
  const tmp = writeTmpYaml('users:\n');
  try {
    const users = loadUsers(tmp);
    assert.equal(users.length, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('chat_id Map lookup matches by integer (the actual bridge path)', () => {
  const tmp = writeTmpYaml(`users:\n  - chat_id: 8412309876\n    user_handle: alice\n    claude_dir: /tmp/alice\n`);
  try {
    const users = loadUsers(tmp);
    const byChatId = new Map(users.map(u => [u.chat_id, u]));
    // Simulate Telegram payload — chat_id arrives as a number from JSON.parse
    const incomingChatId = 8412309876;
    const matched = byChatId.get(incomingChatId);
    assert.ok(matched, 'should find user by numeric chat_id');
    assert.equal(matched.user_handle, 'alice');
    // Negative: a string lookup should NOT match. This guards against the
    // subtle bug where chat_id parsing accidentally produces a string.
    assert.equal(byChatId.get('8412309876'), undefined);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('parses users.example.yaml from the repo root', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const examplePath = path.join(repoRoot, 'users.example.yaml');
  if (!fs.existsSync(examplePath)) {
    assert.fail(`users.example.yaml missing at ${examplePath}`);
  }
  const users = loadUsers(examplePath);
  // Unified example has 3 users; Telegram bridge should see alice + carol
  // (both have chat_id). Bob is Teams-only and should NOT appear.
  assert.equal(users.length, 2);
  const handles = users.map(u => u.user_handle).sort();
  assert.deepEqual(handles, ['alice', 'carol']);
  for (const u of users) {
    assert.equal(typeof u.chat_id, 'number');
    assert.ok(u.claude_dir, 'each user should have a claude_dir');
  }
});
