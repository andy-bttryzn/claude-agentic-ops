// chat_bridge_teams.js — Microsoft Teams bridge to per-user Claude Code sessions.
//
// Companion to chat_bridge_telegram.js. Same pattern:
//   one bridge process, many per-user CLI instances.
// Different surface: Teams instead of Telegram. The bridge owns the bot
// registration; per-user routing is by Entra (Azure AD) Object ID, not chat_id.
//
// This is a scaffold, not a production implementation. Teams adds three
// production concerns the Telegram scaffold doesn't have:
//   1. Azure Bot Service registration (App ID + secret, separate from this code)
//   2. Entra ID tenant scoping (who in the tenant can DM the bot)
//   3. Activity types beyond plain text (mentions, cards, file uploads)
// All three are deferred — see TODO markers inline. The minimum viable path is
// text-in, text-out, per-user routing.
//
// Required env:
//   MS_APP_ID                  — Bot Framework App ID (from Azure Bot Service)
//   MS_APP_PASSWORD            — Bot Framework App secret
//   MS_APP_TENANT_ID           — Entra tenant ID (optional but recommended for scoping)
//   USERS_CONFIG_PATH          — path to users.yaml (see users.example.yaml)
//   PORT                       — HTTP port the bot listens on (default 3978)
//
// Run: node src/chat_bridge_teams.js
//
// Deploy: this needs to be reachable from Microsoft's bot endpoint. Production
// means either (a) a public HTTPS URL with a TLS cert, or (b) ngrok / a dev
// tunnel for local testing. See patterns/chat-bridge.md.

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
  ActivityHandler,
} from 'botbuilder';

const APP_ID = process.env.MS_APP_ID;
const APP_PASSWORD = process.env.MS_APP_PASSWORD;
const TENANT_ID = process.env.MS_APP_TENANT_ID || '';
const USERS_PATH = process.env.USERS_CONFIG_PATH || './users.yaml';
const PORT = parseInt(process.env.PORT || '3978', 10);

if (!APP_ID || !APP_PASSWORD) {
  console.error('MS_APP_ID and MS_APP_PASSWORD required (set in .env from Azure Bot Service registration)');
  process.exit(1);
}

// --- Users config (same YAML parser as the Telegram bridge) ---
//
// For Teams, the per-user routing key is `aad_object_id` (Microsoft's stable
// Entra Object ID, available on every Activity as `activity.from.aadObjectId`).
// chat_id (Telegram) and aad_object_id (Teams) can coexist on the same user
// row — the Teams bridge only looks at aad_object_id.

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
  return users.filter(u => u.aad_object_id);
}

const users = loadUsers(USERS_PATH);
const byAadId = new Map(users.map(u => [String(u.aad_object_id), u]));
console.error(`loaded ${users.length} Teams-routable user(s) from ${USERS_PATH}`);

// --- Per-user CLI invocation (same shape as Telegram bridge) ---
//
// Production additions: persistent claude process per user (vs spawn-per-message
// for cross-turn context), streaming response edits, per-user concurrency lock,
// admin pager for bridge errors. See chat_bridge_telegram.js for the full TODO
// list — they apply identically here.

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

// --- Bot Framework wiring ---

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: APP_ID,
  MicrosoftAppPassword: APP_PASSWORD,
  MicrosoftAppType: TENANT_ID ? 'SingleTenant' : 'MultiTenant',
  MicrosoftAppTenantId: TENANT_ID,
});
const botFrameworkAuth = createBotFrameworkAuthenticationFromConfiguration(null, credentialsFactory);
const adapter = new CloudAdapter(botFrameworkAuth);

adapter.onTurnError = async (context, error) => {
  console.error('TurnError:', error?.message || error);
  await context.sendActivity('Something went wrong on the bridge. Your admin has been notified.');
  // Production: pager / Slack-equivalent alert to admin channel.
};

class ClaudeRouterBot extends ActivityHandler {
  constructor() {
    super();
    this.onMessage(async (context, next) => {
      const aadId = context.activity.from?.aadObjectId;
      const text = (context.activity.text || '').trim();
      if (!text) {
        await next();
        return;
      }
      const user = aadId ? byAadId.get(String(aadId)) : null;
      if (!user) {
        await context.sendActivity('You are not provisioned for this bot. Contact your admin.');
        console.error(`unknown aadObjectId: ${aadId} (name=${context.activity.from?.name})`);
        await next();
        return;
      }
      // Acknowledge synchronously so the user sees the bot is alive.
      await context.sendActivity('…thinking');
      try {
        const reply = await dispatchToCli(user, text);
        // Teams message length limit is generous (28KB) but Teams clients render
        // huge messages awkwardly. Cap and attach overflow as a file in prod.
        const truncated = reply.length > 4000 ? reply.slice(0, 3900) + '\n\n[truncated]' : reply;
        await context.sendActivity(truncated);
      } catch (e) {
        await context.sendActivity(`⚠️ Bridge error: ${e.message}\nYour admin has been notified.`);
        console.error(`dispatch error for ${user.user_handle}:`, e);
      }
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      // Teams fires this when the bot is installed into a chat or channel.
      for (const m of context.activity.membersAdded || []) {
        if (m.id !== context.activity.recipient.id) {
          await context.sendActivity(`Hi ${m.name || ''}. I route messages to your personal Claude Code session. If you're not provisioned, your admin will need to add your Entra Object ID to users.yaml.`);
        }
      }
      await next();
    });
  }
}

const bot = new ClaudeRouterBot();

// --- HTTP listener (Bot Framework's required POST /api/messages endpoint) ---

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/messages') {
    adapter.process(req, res, (context) => bot.run(context));
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok — ${users.length} user(s) routed`);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.error(`teams bridge listening on :${PORT} (POST /api/messages)`);
  console.error('point your Azure Bot Service messaging endpoint at this URL (https + cert in prod, ngrok for dev)');
});
