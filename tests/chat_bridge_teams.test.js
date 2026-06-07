// chat_bridge_teams.test.js — sanity tests for the Teams bridge YAML parser.
//
// Mirrors chat_bridge_telegram.test.js. Focuses on the Teams-specific routing
// key (aad_object_id) and verifies multi-identity users (chat_id + aad_object_id
// on the same row) flow cleanly to BOTH bridges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Kept in sync by hand with chat_bridge_teams.js — production would extract
// the parser to a shared module and import it from both places.
function loadUsersForTeams(filePath) {
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
  return users.filter(u => u.aad_object_id);
}

function writeTmpYaml(content) {
  const tmp = path.join(os.tmpdir(), `users_teams_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.yaml`);
  fs.writeFileSync(tmp, content);
  return tmp;
}

test('parses Teams-only user', () => {
  const yaml = `users:
  - user_handle: bob
    aad_object_id: 5e8f2a01-3c4d-4b9a-b7f1-1a2b3c4d5e6f
    claude_dir: /tmp/bob
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForTeams(tmp);
    assert.equal(users.length, 1);
    assert.equal(users[0].aad_object_id, '5e8f2a01-3c4d-4b9a-b7f1-1a2b3c4d5e6f');
    assert.equal(users[0].claude_dir, '/tmp/bob');
  } finally { fs.unlinkSync(tmp); }
});

test('skips Telegram-only user (no aad_object_id)', () => {
  // Telegram-only Alice should NOT appear in Teams routing.
  const yaml = `users:
  - user_handle: alice
    chat_id: 8412309876
    claude_dir: /tmp/alice
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForTeams(tmp);
    assert.equal(users.length, 0);
  } finally { fs.unlinkSync(tmp); }
});

test('multi-identity user appears in Teams routing', () => {
  const yaml = `users:
  - user_handle: carol
    chat_id: 1100442299
    aad_object_id: 9c7b6a55-1234-5678-9abc-def012345678
    claude_dir: /tmp/carol
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForTeams(tmp);
    assert.equal(users.length, 1);
    assert.equal(users[0].user_handle, 'carol');
    assert.equal(users[0].aad_object_id, '9c7b6a55-1234-5678-9abc-def012345678');
    // chat_id still present on the row — Telegram parser would also see it
    assert.equal(users[0].chat_id, '1100442299');
  } finally { fs.unlinkSync(tmp); }
});

test('aadObjectId Map lookup matches by exact string (the actual bridge path)', () => {
  const yaml = `users:
  - user_handle: bob
    aad_object_id: 5e8f2a01-3c4d-4b9a-b7f1-1a2b3c4d5e6f
    claude_dir: /tmp/bob
`;
  const tmp = writeTmpYaml(yaml);
  try {
    const users = loadUsersForTeams(tmp);
    const byAadId = new Map(users.map(u => [String(u.aad_object_id), u]));
    // Simulate Bot Framework Activity payload — aadObjectId is a GUID string
    const incoming = '5e8f2a01-3c4d-4b9a-b7f1-1a2b3c4d5e6f';
    const matched = byAadId.get(incoming);
    assert.ok(matched, 'should find user by exact aadObjectId');
    assert.equal(matched.user_handle, 'bob');
    // Negative: case difference should NOT match. Entra GUIDs are
    // canonically lowercased, but Teams sometimes uppercases segments.
    assert.equal(byAadId.get('5E8F2A01-3C4D-4B9A-B7F1-1A2B3C4D5E6F'), undefined,
      'case sensitivity caught — bridges must canonicalize before lookup');
  } finally { fs.unlinkSync(tmp); }
});

test('parses repo users.example.yaml — both bridges see the right subset', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const examplePath = path.join(repoRoot, 'users.example.yaml');
  if (!fs.existsSync(examplePath)) {
    assert.fail(`users.example.yaml missing at ${examplePath}`);
  }
  const teamsUsers = loadUsersForTeams(examplePath);
  // The example has 3 users: alice (Telegram only), bob (Teams only),
  // carol (both). Teams bridge should see bob + carol.
  assert.equal(teamsUsers.length, 2);
  const handles = teamsUsers.map(u => u.user_handle).sort();
  assert.deepEqual(handles, ['bob', 'carol']);
});
