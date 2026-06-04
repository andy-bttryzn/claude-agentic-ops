# Security Invariants for Agents That Touch Untrusted Content

An agentic ops system that reads inbound email bodies, scrapes vendor pages, or renders LLM output through scripts holding OAuth tokens has a specific threat profile. Five code-level invariants protect against the worst classes — adapted from the RoleScout `SECURITY.md` model.

The model assumes the LLM **can** be prompt-injected. Defenses live at the host-system layer, not at the prompt layer.

## Invariant 1 — never build a shell command from scraped or LLM text

Vendor names, email subjects, scraped page text, and LLM-generated suggestions all reach scripts that spawn child processes. A template-string `execSync` is a remote-code-execution vector.

**Banned:**

```js
execSync(`node helper.js ${vendorName}`);  // backticks, $(), ;, |, newlines all survive quote-escaping
```

**Required:**

```js
spawnSync('node', ['helper.js', vendorName], { encoding: 'utf8', windowsHide: true });
```

The argv array bypasses the shell entirely. `vendorName` is passed as a single argument no matter what it contains.

**Why this matters:** even `JSON.stringify(name)` only escapes inner quotes. Shell metacharacters outside the quote boundary still execute. Argv-only is the only safe pattern.

## Invariant 2 — markdown → HTML must go through a sanitizer

If your agent renders reports, briefs, or LLM output as HTML in an operator-facing surface (browser, email client, PDF), the markdown library alone does not sanitize. `marked` (and similar) will happily render `<img src=x onerror=...>` from LLM output.

**Pattern:** wrap your markdown render in a `safeMarkdown()` helper that pipes through `sanitize-html` with an allowlist.

```js
function safeMarkdown(md) {
  return sanitizeHtml(marked.parse(md), {
    allowedTags: [...defaultAllowedTags, 'code', 'pre'],
    allowedAttributes: { a: ['href'], code: ['class'], pre: ['class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}
```

Every codepath that turns markdown into HTML uses this. No exceptions for "this one is internal-only" — internal LLM output is still untrusted.

## Invariant 3 — paths from content go through `safeJoin` / `validJobId`

Report paths, attachment filenames, vendor slugs, and ID-keyed URLs are user-or-LLM-writable. A path traversal bug looks like:

```js
fs.readFileSync(path.join(ROOT, userProvidedRel));  // ../../etc/passwd lands here
```

**Pattern:** validate before joining.

```js
function safeJoin(root, rel) {
  const resolved = path.resolve(root, rel);
  const relCheck = path.relative(root, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return resolved;
}

function validJobId(id) {
  return /^[a-f0-9]{12}$|^app-\d+$/.test(id) ? id : null;
}
```

`safeJoin` returns null if the path escapes ROOT. `validJobId` allowlists the exact format you expect for ID-keyed writes.

## Invariant 4 — secrets get owner-only permissions

`credentials.json`, `.env`, OAuth token files, monday/Anthropic API keys all live on disk. The minimum guard:

- `chmod 0600` after write (POSIX)
- Verify the path is **not inside** a Dropbox / iCloud / OneDrive / Google Drive synced folder
- gitignored — confirmed by `git check-ignore` in CI

The sync-folder check matters because a leaked plaintext key in a synced folder syncs to every device on the operator's account, including phones with auto-backup.

## Invariant 5 — OAuth `redirect_uri` pinned to bound loopback

The Google / monday / Anthropic OAuth flows all support a `redirect_uri`. A reverse-proxy / DNS-rebinding attack can trick a local agent server into accepting tokens for the wrong domain.

**Pattern:** hardcode the loopback URI; don't derive it from `Host` / `X-Forwarded-*` headers.

```js
const REDIRECT_URI = `http://localhost:${PORT}`;  // never req.headers.host
```

If your agent's local web UI needs to be exposed beyond loopback (Tailscale, reverse proxy), gate that behind an explicit env var (`TRUST_PROXY=1`) and document the risk.

## Audit cadence

Quarterly:
- Grep the entire codebase for `execSync\(\`` and `exec\(\`` patterns. Any new occurrences require explanation.
- Run a path-traversal probe against any new file-read codepath that takes a name/ID from external content.
- Verify the secrets file ACL hasn't drifted (run a check, not an assumption).

Per-feature:
- Any new codepath that reads inbound email content, scraped HTML, or LLM output and feeds it into ANY of (shell, file read, HTTP request, DB query) gets a security review before merge.

## Known follow-ups (not addressed by the five base invariants)

These are tracked separately:

- **CSRF / DNS-rebinding** on local mutating endpoints: add a `Host`-header allowlist middleware
- **SSRF** on Playwright navigation: block private IP ranges and metadata service URLs (`169.254.169.254`)
- **Prompt-injection at the LLM level**: structured input markers (wrap external content in `<untrusted>` tags), pre-tool-use hooks that pattern-match obvious injection attempts. These are partial defenses; the five base invariants assume they may fail.

## Why not "just trust the LLM"

Prompt-injection mitigations at the model layer are an active research area. Treating them as load-bearing is premature. The five code-level invariants assume the agent **will** be tricked at some point, and harden the host system so that compromise stays contained.
