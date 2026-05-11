---
id: inbox-to-brain
name: Inbox-to-Brain
version: 1.1.0
description: Raw captures dropped into <vault>/inbox/*.md get promoted to canonical brain pages by an LLM agent invoked on a cron. Agent writes markdown FILES into the vault; gbrain sync (separate cron) indexes them on its next tick. Matches the email-to-brain / calendar-to-brain pattern — recipe is just a skill + a cron line; the agent does the LLM work using its own auth.
category: sense
requires: []
secrets: []
health_checks:
  - type: command
    command: "claude --version"
    label: "claude CLI installed"
  - type: command
    command: "claude mcp list"
    label: "gbrain MCP server registered"
setup_time: 5 min
cost_estimate: "$0 incremental (uses your Claude subscription quota — Pro / Max / Team / etc.)"
---

# Inbox-to-Brain: Drop a File, Get a Brain Page

You drop a capture (article clipping, meeting note, X post, idea) into
`<vault>/inbox/*.md`. Within ~15 minutes, an LLM agent classifies it, files
the canonical page in the right folder (`concepts/`, `people/`, `meetings/`,
etc.), back-links every mentioned entity per the Iron Law, preserves the raw
source, and deletes the inbox file. Failures land in `inbox/_failed/` for
triage.

## IMPORTANT: Instructions for the Agent (installer)

**You are the installer.** Follow the steps below precisely.

**The core pattern: code for data, LLMs for judgment** — same as `email-to-brain`,
`calendar-to-brain`, `x-to-brain`. The recipe never makes its own LLM calls and
never needs `ANTHROPIC_API_KEY`. The agent that runs gbrain does the judgment
using its own auth (Claude subscription, OpenClaw token, etc.).

**Why this shape:** captures are sporadic. Most cron ticks find an empty inbox.
Occasionally there are 1-3 files. Serial processing in a single agent turn is
sufficient and simpler than fan-out. The agent reads each file, decides where
it belongs, writes via gbrain MCP, then cleans up.

## Architecture

```
<vault>/inbox/<capture>.md            ← user drops files (Telegram, Claude Code, Obsidian sync)
   │
   │ */15 * * * *  (OpenClaw cron OR system crontab)
   ▼
agent: Sage (OpenClaw isolated session) OR claude -p (Claude Code headless)
   reads the inbox-to-brain skill, processes inbox using its own auth + Bash + gbrain CLI
   │
   ▼
agent (serial, one file at a time):
   ├─ Bash: ls <vault>/inbox/*.md  (top-level only)
   ├─ if empty → exit silently
   │
   └─ for each file:
       ├─ Read file content
       ├─ classify (article | meeting | x-post | idea | media | capture)
       ├─ Bash: gbrain search "<name>"           (read-only, find candidate slugs)
       ├─ Bash: gbrain get <slug>                (read-only, load existing context)
       ├─ decide destination per skills/_brain-filing-rules.md
       ├─ compose canonical content (frontmatter + State + Timeline +
       │                              [[wikilinks]] + [Source: ...])
       ├─ Write <vault>/<destination>.md       ← FILE in the vault, not DB
       ├─ for each notable entity:
       │     · if entity .md does NOT exist on disk → Write the new file
       │     · if it exists → Edit to insert a dated timeline entry under
       │       the <!-- timeline --> separator (additive only — do NOT
       │       rewrite the State section or frontmatter)
       │     · Iron Law back-link is the [[wikilink]] in the new content;
       │       sync's auto-link post-hook materializes the typed edge
       ├─ mcp__gbrain__file_upload <raw> --page <destination>  (raw → .raw/)
       ├─ Bash: gbrain files upload-raw <raw> --page <destination_slug>  (raw → .raw/)
       ├─ Bash: gbrain call log_ingest '{...}'   (DB audit trail)
       └─ Bash: rm <raw inbox file>   OR   mv to inbox/_failed/<basename> + .error sidecar
   │
   ▼
Write <vault>/reports/inbox-ingest/YYYY-MM-DD.md           (digest, FILE)
```

**Why files, not DB rows:** gbrain's design is filesystem-first. The vault
markdown files are the source of truth; gbrain's DB is a derived index that
sync rebuilds from filesystem on a 5-min tick. Writing only via `gbrain put`
or MCP `put_page` creates a DB-only orphan that the next sync tick deletes.
The agent must `Write` real files into the vault.

The skill uses Bash + `gbrain` CLI rather than MCP tool names so it's
agent-platform-agnostic — Sage (via OpenClaw isolated session), Claude Code
(via headless `-p`), Hermes, or any other agent that has Bash + gbrain on
PATH can run it identically. Skills are exposed to OpenClaw via the symlink
`~/.openclaw/workspace/skills → ~/gbrain/skills` (set up automatically by
OpenClaw install).

## Prerequisites

1. **GBrain installed and configured** — `gbrain doctor` passes. `bun` on PATH (or available at `$HOME/.bun/bin/bun`).

2. **An agent platform** to run the skill on a cron. Pick one:
   - **OpenClaw (preferred for users already running it)** — verify `openclaw cron status` returns `enabled: true`. Sage in isolated sessions has Bash + gbrain access by default. Skills are auto-discovered via the `~/.openclaw/workspace/skills → ~/gbrain/skills` symlink that OpenClaw install sets up.
   - **Claude Code headless (no OpenClaw)** — verify `claude --version` and that subscription auth works:
     ```bash
     claude -p "say ok" --output-format json | jq -r .result   # → "ok"
     ```
     Headless `claude -p` prefers `ANTHROPIC_API_KEY` over OAuth subscription. **Do not set `ANTHROPIC_API_KEY` in the cron environment** — if set, you're billed per-token instead of via subscription.

3. **gbrain registered as an MCP server for Claude Code** (only needed for the Claude Code path; OpenClaw uses gbrain via Bash CLI directly):
   ```bash
   claude mcp add gbrain "gbrain serve"
   claude mcp list   # gbrain should appear in the list
   ```
4. **Cron log directory:**
   ```bash
   mkdir -p ~/.gbrain/logs
   ```

## Setup Flow

### Step 1 — Confirm the Skill Is in Place

The skill lives in this repo at `skills/inbox-to-brain/SKILL.md`. If you cloned
gbrain at `~/gbrain`, the absolute path is `~/gbrain/skills/inbox-to-brain/SKILL.md`.
Confirm:

```bash
test -f ~/gbrain/skills/inbox-to-brain/SKILL.md && echo "skill OK" || echo "skill missing"
```

The skill hard-codes the vault path. Edit `skills/inbox-to-brain/SKILL.md` to
point at your vault if it isn't `/mnt/c/Users/vinod/Documents/Notes/vin-notes`.

### Step 2 — Smoke Test: Describe-Only

Verify the agent reads the skill correctly without writing anything:

```bash
{ cat ~/gbrain/skills/inbox-to-brain/SKILL.md; printf '\n\nADDITIONAL INSTRUCTION FOR THIS RUN: This is a DESCRIBE-ONLY dry run. Do not call any mcp tool. Do not modify any file. Do not run rm or mv. Read the inbox listing, optionally Read each file, then describe in plain prose what you would do.\n'; } \
  | claude -p --allowedTools "Read,Bash" --output-format text
```

The skill **must be fed via stdin**, not via `"$(cat ...)"` as a positional
argument: the skill's YAML frontmatter starts with `---`, which Claude Code's
flag parser misinterprets as an unknown long-option.

The agent should: list `inbox/*.md`, describe its plan for each file (classify, choose destination, etc.), and stop. Confirm the described behaviour matches your intent before going live.

### Step 3 — Live Smoke Test: One File

Drop a tiny test capture:

```bash
cat > /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/_smoke.md <<'EOF'
---
source: manual smoke test
captured_at: 2026-04-24T22:00:00Z
context: Smoke testing inbox-to-brain v1.0
---
# Smoke test
This file references [alice-example](https://example.com/alice) in the context
of the [acme-example](https://acme.example.com) launch on 2026-04-24.
EOF
```

Run the agent live (use the same `echo … ; cat skill ;` pattern as the cron — see Step 4 for the rationale):

```bash
{ echo "Execute the following inbox-to-brain skill now. Begin Step 1 immediately."; cat ~/gbrain/skills/inbox-to-brain/SKILL.md; } \
  | claude -p --allowedTools "Read,Write,Edit,Bash,mcp__gbrain__search,mcp__gbrain__get_page,mcp__gbrain__get_backlinks,mcp__gbrain__list_pages,mcp__gbrain__resolve_slugs,mcp__gbrain__file_upload,mcp__gbrain__log_ingest"
```

After it completes, verify:

```bash
# raw file gone
test ! -f /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/_smoke.md && echo "raw deleted ✓"

# canonical page (slug depends on classifier; expected something like concepts/smoke-test or media/x/alice-acme-launch)
gbrain query "smoke test"

# digest
gbrain get reports/inbox-ingest/$(date -u +%F)
```

### Step 4 — Schedule via OpenClaw cron (preferred for OpenClaw users)

If you run [OpenClaw](https://openclaw.ai), schedule via its built-in cron (matches the pattern used by the other gbrain-* jobs like `gbrain-health-digest`, `gbrain-dream-cycle`):

```bash
openclaw cron add \
  --name "inbox-to-brain" \
  --description "Cron-driven inbox ingest per gbrain inbox-to-brain skill." \
  --cron "*/15 * * * *" \
  --tz "America/Chicago" \
  --agent main \
  --session isolated \
  --wake now \
  --message 'Process my vault inbox now per the inbox-to-brain skill at /home/itadmin/gbrain/skills/inbox-to-brain/SKILL.md.

This is an autonomous cron-fired run; no user is available to ask clarifying questions. Begin Step 1 (skill: enumerate inbox) immediately. If inbox is empty, log a single line and exit silently.

Vault root: /mnt/c/Users/vinod/Documents/Notes/vin-notes'

# Disable the default Telegram fallback delivery (otherwise empty-inbox runs get marked
# error because there's nothing to deliver):
openclaw cron edit <new-job-id> --no-deliver
```

Verify:
```bash
openclaw cron list                                    # job appears with `*/15 * * * *`
openclaw cron run <job-id>                            # manually trigger one run
openclaw cron runs --id <job-id>                      # see run history
tail -1 ~/.openclaw/cron/runs/<job-id>.jsonl          # last run's structured log
```

The OpenClaw scheduler runs the job as Sage in an isolated session, drawing on whatever auth your OpenClaw is configured with. No `ANTHROPIC_API_KEY` needed — Sage uses subscription auth via OpenClaw's gateway.

### Step 4 (alternative) — System crontab + `claude -p`

If you don't run OpenClaw, schedule via your user crontab using a `claude -p` headless invocation:

```cron
*/15 * * * * { echo "Execute the following inbox-to-brain skill now. This is an autonomous cron-fired run; there is no user to ask clarifying questions. Begin Step 1 immediately. If inbox is empty, log a single line and exit silently. Do not narrate, do not ask what to do."; cat /home/itadmin/gbrain/skills/inbox-to-brain/SKILL.md; } | /home/itadmin/.local/bin/claude -p --output-format text >> $HOME/.gbrain/logs/inbox-to-brain.log 2>&1
```

Two non-obvious bits worth understanding when using this path:

1. **The skill is fed via stdin (the `{ echo … ; cat skill.md ; }` group piped into `claude -p`)**, not via `"$(cat ...)"`. Its YAML frontmatter starts with `---`, which Claude Code's flag parser misinterprets as an unknown long-option.
2. **The leading `echo` directive is non-optional.** Without it, when claude-p is fed only the skill text on stdin, the agent treats the input as documentation being shown for review (it asks "what would you like me to do with this?") rather than as instructions to execute. The directive flips it into autonomous-execution mode.

The system-crontab path uses your Claude subscription auth stored in `~/.claude/`. It must run as the user (not root). Don't add `ANTHROPIC_API_KEY` to the cron env.

## Verification

| Check | Command | Expected |
|---|---|---|
| `claude` reachable | `claude --version` | prints version |
| Subscription auth works | `claude -p "say ok" --output-format json \| jq -r .result` | `ok` |
| MCP gbrain registered | `claude mcp list \| grep gbrain` | non-empty |
| Empty inbox | run cron line manually with empty `inbox/` | log shows `inbox empty, exiting`; no writes |
| Single-file smoke | step 3 above | canonical page lands, raw deleted, digest written |
| Failure path | drop random bytes as `inbox/_garbage.md`; run | file lands in `inbox/_failed/_garbage.md` with `.error` sidecar; digest flags it |
| Cron log | `tail ~/.gbrain/logs/inbox-to-brain.log` | one block per fired tick |
| No API-token billing | check Anthropic console | zero token consumption from `claude -p` calls |

## Operations Cheatsheet

| Task | Command |
|---|---|
| Tail the cron log | `tail -f ~/.gbrain/logs/inbox-to-brain.log` |
| Force a run now | `{ echo "Execute the following inbox-to-brain skill now."; cat ~/gbrain/skills/inbox-to-brain/SKILL.md; } \| claude -p --allowedTools "..."` |
| Retry a quarantined file | `mv ~/<vault>/inbox/_failed/<name>.md ~/<vault>/inbox/` (next tick picks it up) |
| Inspect today's digest | `gbrain get reports/inbox-ingest/$(date -u +%F)` |
| Pause processing | comment out the crontab line — files just accumulate in inbox/ until you re-enable |
| Edit behaviour | edit `skills/inbox-to-brain/SKILL.md`; takes effect next tick (skill is inlined into the prompt at fire-time) |

## Known Limitations

- **Single-source writes.** gbrain ops currently default to `source_id='default'`. The recipe is single-source.
- **Vault path is hard-coded** in the skill. For multi-vault setups, fork the skill or refactor to read from a config file.
- **Subscription rate limits** still apply. Max 20x is generous; smaller plans may hit limits on heavy capture days.
- **One file's failure doesn't break the batch**, but a hard agent-level error (auth, MCP unreachable) does abort the tick — log shows the cause; next tick retries.
- **No file lock.** If two cron ticks somehow overlap (long-running first tick + next tick fires), they may race on the same files. In practice the second tick finds whatever the first hasn't yet processed.

## Why Not gbrain Minions?

Earlier attempts (v1-v3 of this design) used `gbrain agent run --fanout-manifest`
to spawn one durable subagent per file. Two reasons we moved away:

1. **gbrain's subagent handler uses `new Anthropic()` directly** — billed per-token via `ANTHROPIC_API_KEY`, with no path to the user's subscription quota.
2. **gbrain Minions is a job queue**, not a recipe primitive. Other gbrain recipes (`email-to-brain`, etc.) don't use it; they defer to the agent that runs gbrain. v4 follows that pattern, eliminating queue plumbing entirely.

Minions is still the right tool for *bulk one-off durable* work — re-embedding 1000 stale chunks, auditing 10 flagged pages — where queue durability and retry matter. For sporadic per-file recipes, a cron-driven agent invocation is the right primitive.
