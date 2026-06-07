// chat_bridge_slack.js — Slack bridge to per-user Claude Code sessions.
//
// Third surface in the chat_bridge family. Same shape as the Telegram and
// Teams scaffolds: one bridge process, many per-user CLI instances. Slack
// routes by Slack `user.id` (e.g. "U0123ABCD"), which is workspace-stable.
//
// Uses Bolt for JavaScript (@slack/bolt) — the official Slack SDK. Bolt
// handles signing-secret verification, event payload parsing, and the
// thread/DM/channel distinction so this file doesn't have to.
//
// Required env:
//   SLACK_BOT_TOKEN            — xoxb-… token from your Slack app's OAuth page
//   SLACK_SIGNING_SECRET       — from the app's Basic Information page
//   SLACK_APP_TOKEN            — xapp-… token for Socket Mode (preferred for dev,
//                                works in prod too; avoids needing a public URL)
//   USERS_CONFIG_PATH          — path to users.yaml
//   PORT                       — only used if NOT in Socket Mode (default 3000)
//
// Run: node src/chat_bridge_slack.js

import 'dotenv/config';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import bolt from '@slack/bolt';
const { App } = bolt;

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const USERS_PATH = process.env.USERS_CONFIG_PATH || './users.yaml';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET required');
  process.exit(1);
}

// --- Users config (unified YAML; same parser shape as Telegram/Teams) ---
//
// Slack routing key is `slack_user_id` (Slack's workspace-stable user id like
// "U0123ABCD"). Same row can carry chat_id (Telegram) and aad_object_id (Teams)
// and slack_user_id (Slack) — the bridge ignores keys it doesn't recognize.

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
    const kv = line.match(/^\s*(?:-\s+)?(\w+):\s*(.+?)\s*$/);
    if (kv) cur[kv[1]] = kv[2];
  }
  if (cur && Object.keys(cur).length) users.push(cur);
  return users.filter(u => u.slack_user_id);
}

const users = loadUsers(USERS_PATH);
const bySlackId = new Map(users.map(u => [String(u.slack_user_id), u]));
console.error(`loaded ${users.length} Slack-routable user(s) from ${USERS_PATH}`);

// --- Per-user CLI invocation (same shape as Telegram/Teams bridges) ---

async function dispatchToCli(user, prompt) {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', ['-p', prompt], {
      cwd: user.claude_dir, env: process.env, windowsHide: true,
    });
    let out = '', err = '';
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', reject);
    cp.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      resolve(out.trim());
    });
  });
}

// --- Bolt wiring ---

const app = new App({
  token: BOT_TOKEN,
  signingSecret: SIGNING_SECRET,
  socketMode: !!APP_TOKEN,
  appToken: APP_TOKEN,
  port: PORT,
});

// Direct messages and @-mentions both end up here. Bolt's `message` event
// fires for DMs to the bot; `app_mention` fires for @-mentions in channels.

async function handleInbound({ event, client, say }) {
  const slackId = event.user;
  const text = (event.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (!text) return;
  const user = bySlackId.get(String(slackId));
  if (!user) {
    await say('You are not provisioned for this bot. Contact your admin.');
    console.error(`unknown slack user: ${slackId}`);
    return;
  }
  // Acknowledge — Slack shows the "thinking" message immediately.
  const ack = await say({ text: '…thinking', thread_ts: event.thread_ts || event.ts });
  try {
    const reply = await dispatchToCli(user, text);
    // Slack message limit is 40k chars; render-friendly cap at ~4k.
    const truncated = reply.length > 4000 ? reply.slice(0, 3900) + '\n\n[truncated]' : reply;
    await client.chat.update({
      channel: event.channel,
      ts: ack.ts,
      text: truncated,
    });
  } catch (e) {
    await client.chat.update({
      channel: event.channel,
      ts: ack.ts,
      text: `⚠️ Bridge error: ${e.message}\nYour admin has been notified.`,
    });
    console.error(`dispatch error for ${user.user_handle}:`, e);
  }
}

app.message(async (ctx) => {
  // Only respond to plain user messages — skip bot messages, message_changed,
  // joins/leaves, etc.
  if (ctx.event.subtype) return;
  await handleInbound(ctx);
});

app.event('app_mention', async (ctx) => {
  await handleInbound(ctx);
});

await app.start();
console.error(`slack bridge started ${APP_TOKEN ? '(Socket Mode)' : `on :${PORT}`}`);
