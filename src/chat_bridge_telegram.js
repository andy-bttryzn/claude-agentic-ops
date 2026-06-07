// chat_bridge_telegram.js — minimal Telegram bridge to per-user Claude Code sessions.
//
// Pattern: one bridge process, many per-user CLI instances. Each inbound message is
// routed by Telegram chat_id to the user's claude_dir; `claude -p` is spawned with
// that as cwd. The CLI auto-loads the user's memory + state from the dir.
//
// This is a scaffold, not a production implementation. Production additions noted
// inline as TODO comments. See patterns/chat-bridge.md for the full pattern.
//
// Required env:
//   TELEGRAM_BOT_TOKEN — your bot's token from @BotFather
//   USERS_CONFIG_PATH  — path to users.yaml (see users.example.yaml in repo root)
//
// Run: node src/chat_bridge_telegram.js

import 'dotenv/config';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USERS_PATH = process.env.USERS_CONFIG_PATH || './users.yaml';
if (!TG_TOKEN) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }

// Minimal yaml parser for users.yaml — rows can lead with any identity key
// (chat_id, aad_object_id, user_handle); we collect all keys per row, then
// keep only rows that have chat_id (Telegram's routing key). Production: use
// `yaml` or `js-yaml` from npm.
function loadUsers(path) {
  const text = fs.readFileSync(path, 'utf8');
  const users = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.match(/^\s*-\s+/)) {
      if (cur) users.push(cur);
      cur = {};
    }
    if (!cur) continue;
    // Match key:value on either a list-item line ("  - key: val") or a
    // continuation line ("    key: val"). The leading "- " is optional.
    const kv = line.match(/^\s*(?:-\s+)?(\w+):\s*(.+?)\s*$/);
    if (kv) cur[kv[1]] = kv[2];
  }
  if (cur && Object.keys(cur).length) users.push(cur);
  // Telegram bridge only cares about rows with a chat_id. Coerce to Number
  // for the Map lookup (Telegram payload arrives with chat_id as integer).
  return users
    .filter(u => u.chat_id !== undefined)
    .map(u => ({ ...u, chat_id: Number(u.chat_id) }));
}

const users = loadUsers(USERS_PATH);
const byChatId = new Map(users.map(u => [u.chat_id, u]));
console.error(`loaded ${users.length} user(s) from ${USERS_PATH}`);

// ---- Telegram API helpers ----

async function tgApi(method, params = {}) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

const sendMessage = (chat_id, text) => tgApi('sendMessage', { chat_id, text });
const editMessage = (chat_id, message_id, text) => tgApi('editMessageText', { chat_id, message_id, text });

// ---- Per-user CLI invocation ----
//
// Production-quality version would:
//   - Maintain a persistent `claude` process per user (for conversational continuity),
//     not spawn `claude -p` per message. This loses cross-turn context.
//   - Stream stdout chunks back to Telegram via editMessage (rate-limited to ~30/min/chat).
//   - Enforce per-user concurrency (one in-flight invocation per user, queue the rest).
//   - Time out after N minutes with a visible-to-user fallback message.
//   - Persist user transcripts for audit + replay.

async function dispatchToCli(user, prompt) {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', ['-p', prompt], {
      cwd: user.claude_dir,
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', reject);
    cp.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      resolve(out.trim());
    });
  });
}

// ---- Inbound message handler ----

async function handleMessage(msg) {
  const chat_id = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;
  const user = byChatId.get(chat_id);
  if (!user) {
    await sendMessage(chat_id, 'You\'re not provisioned for this bot. Contact your admin.');
    console.error(`unknown chat_id ${chat_id} from ${msg.from?.username || '?'}`);
    return;
  }
  // Acknowledge so user sees the bot is alive.
  const ack = await sendMessage(chat_id, '…thinking');
  try {
    const reply = await dispatchToCli(user, text);
    // Telegram message cap is 4096 chars; production: split or attach as file.
    const truncated = reply.length > 4000 ? reply.slice(0, 3900) + '\n\n[truncated]' : reply;
    await editMessage(chat_id, ack.message_id, truncated);
  } catch (e) {
    await editMessage(chat_id, ack.message_id, `⚠️ Bridge error: ${e.message}\nYour admin has been notified.`);
    console.error(`dispatch error for ${user.user_handle}:`, e);
    // Production: post to admin channel / pager.
  }
}

// ---- Long-poll loop ----
//
// Production: use a webhook instead. Webhooks reduce latency from ~poll-interval
// down to ~150ms and don't require an outbound long-poll. Long-polling is here
// because it works without any inbound HTTP setup — easier to demo.

let offset = 0;
async function pollLoop() {
  while (true) {
    try {
      const updates = await tgApi('getUpdates', { offset, timeout: 30 });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) handleMessage(u.message).catch(e => console.error('handler:', e));
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

console.error('bridge started, polling for messages…');
pollLoop();
