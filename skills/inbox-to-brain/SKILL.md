---
name: inbox-to-brain
version: 1.2.0
description: |
  Promote raw captures in <vault>/inbox/*.md to canonical brain pages with
  proper filing, Iron Law back-links, and provenance. Cron-driven, sporadic
  per-tick volume (0-3 files), processed serially. The agent invoking this
  skill (Sage / Claude Code / OpenClaw / Hermes / etc.) writes canonical
  markdown FILES into the vault using its own auth and its own tools — sync
  indexes them on the next 5-min tick. Recipe never makes its own LLM calls
  and never needs ANTHROPIC_API_KEY.
triggers:
  - "process my inbox"
  - "ingest captures"
  - "promote inbox"
  - "run inbox-to-brain"
tools:
  - Read
  - Write
  - Edit
  - Bash
  - gbrain
mutating: true
writes_pages: true
writes_to:
  - concepts/
  - people/
  - companies/
  - entities/
  - projects/
  - meetings/
  - media/
  - references/
  - life/
  - reports/inbox-ingest/
---

# Inbox-to-Brain Skill

You are running on a cron, headless. Your job: read each raw capture in
`<vault>/inbox/*.md`, decide where it belongs, **write the canonical markdown
file into the vault filesystem**. The brain's own sync cron (every 5 min)
indexes the new files into gbrain's DB.

> **CRITICAL — write FILES, not DB rows.** The vault filesystem is the source
> of truth; gbrain's DB is a derived index that sync rebuilds from disk.
> Writing only via `gbrain put` (DB-only) or MCP `put_page` orphans on the
> next sync tick. ALWAYS use `Write` and `Edit` tools to create canonical
> markdown files. Use `gbrain` CLI (via Bash) only for read-only research,
> raw-source preservation, and the audit log.

> **Filing rule:** read `<gbrain>/skills/_brain-filing-rules.md` for the
> canonical filing-by-primary-subject rules before composing any new page.
>
> **Ingest protocol:** `<gbrain>/skills/ingest/SKILL.md` has Phases 1-6
> (parse → entities → timeline → cross-refs → Iron Law back-links → timeline
> merge), citation format, and notability gate. This skill is the *driver*;
> the protocol it enforces lives there.

## Vault and gbrain paths

- Vault root: `/mnt/c/Users/vinod/Documents/Notes/vin-notes`
- gbrain repo: `/home/itadmin/gbrain` (skills also reachable via `~/.openclaw/workspace/skills/` symlink for OpenClaw)
- Inbox: `<vault>/inbox/`
- Quarantine: `<vault>/inbox/_failed/` (created lazily if missing)
- Digest target file: `<vault>/reports/inbox-ingest/<YYYY-MM-DD>.md`

## Step 0 — Environment setup (idempotent, run once at the top)

```bash
export PATH="$HOME/.bun/bin:$PATH"
set -a && . "$HOME/.gbrain/.env" && set +a
```

This puts `gbrain` on PATH and loads `OPENAI_API_KEY` / `GBRAIN_DATABASE_URL`
needed for gbrain CLI operations.

## Step 1 — Enumerate

```bash
ls /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/*.md 2>/dev/null
```

**Skip:**
- subdirectories (`_processed/`, `_processing/`, `_failed/`, `pipedrive/`, `.obsidian/`, etc.)
- dotfiles
- non-`.md` files

**If the listing is empty**, log a single line `inbox empty, exiting` and stop.
Do not write a digest, do not call any brain tool.

## Step 2 — Per-file processing (serial, one at a time)

For each file the listing returned, do the following in order:

### 2a. Read the file (filesystem)

```
Read tool → full file content
```

Inspect YAML frontmatter (if any) for `source`, `captured_at`, `context`.

### 2b. Classify

One of: `article` | `meeting` | `x-post` | `idea` | `media` | `capture`.
- `article` — third-party essay, blog post, paper
- `meeting` — transcript or notes
- `x-post` — tweet, thread, social-media capture
- `idea` — operator's own original thinking
- `media` — video, audio, PDF, screenshot
- `capture` — short factual operator note (e.g. Telegram capture confirming a deal closed)

### 2c. Research existing brain context (read-only via `gbrain` CLI)

```bash
gbrain search "<name>"                  # find candidate slugs
gbrain get <slug>                       # if a candidate exists, load its content
gbrain backlinks <slug>                 # optional: see what already links to it
```

Apply the notability gate from `<gbrain>/skills/ingest/SKILL.md` — not every name is worth a page.

### 2d. Decide canonical destination

Per `<gbrain>/skills/_brain-filing-rules.md`: **file by primary subject**, not format.

Quick reference (verify via `gbrain search` to match existing convention before inventing a new namespace):
- About a person → `entities/people/<slug>` or `people/<slug>` — match existing
- About a company / org → `entities/companies/<slug>` or `companies/<slug>` — match existing
- Reusable framework / mental model → `concepts/<slug>`
- Third-party article / podcast / video with substantive thinking → `references/<slug>`
- Meeting transcript or notes → `meetings/YYYY-MM-DD-<slug>` (or `projects/<project>/meetings/<...>` for project-specific meetings)
- Tweet / thread → primary subject's page, or `X/<YYYY-MM-DD>-<handle>-<topic>` if standalone
- Video / podcast → `media/videos/<slug>` or `media/podcasts/<slug>` (or `references/<slug>` if substantive thinking)
- Project-specific work item → `projects/<project>/<slug>`
- Operator's original idea → `concepts/<slug>` or `originals/<slug>`

If a destination page **already exists** (e.g. a Pipedrive-synced deal), prefer **updating** it (Step 2g) over creating a sibling.

### 2e. Compose canonical page content

Per `<gbrain>/skills/ingest/SKILL.md`:
- YAML frontmatter (`type`, `title`, `tags`, source metadata)
- State / compiled-truth section (current best understanding, **rewritten** not appended)
- Optional `<!-- timeline -->` separator + Timeline section (newest first, dated entries)
- Inline `[Source: ...]` citation on every fact:
  - operator's verbatim words: `[Source: Telegram capture, YYYY-MM-DDTHH:MMZ]`
  - third-party article: `[Source: <publication>, <URL>, YYYY-MM-DD]`
  - meeting: `[Source: Meeting "<title>", YYYY-MM-DD]`
  - X post: `[Source: X/@handle, YYYY-MM-DD](URL)`
- **Wikilinks for cross-references**: `[[entities/people/alice-example|Alice Example]]` in the body. Sync's auto-link post-hook will create the `link` rows from these on its next tick.

For the operator's **own thinking**, quote verbatim. Their exact phrasing IS the insight.

### 2f. Write the canonical page (FILESYSTEM)

```
Bash: mkdir -p <vault>/<slug-parent>/
Write: <vault>/<slug>.md       ← the composed content
```

Example: for slug `concepts/example`, write to `/mnt/c/Users/vinod/Documents/Notes/vin-notes/concepts/example.md`.

**Do NOT use `gbrain put`** for the canonical page — it writes to the DB only and the next sync tick will delete the orphan. The `Write` tool is the canonical path.

### 2g. Update entity pages (FILESYSTEM, additive only)

For each notable entity:

- **If the entity page does NOT exist on disk**:
  ```
  Bash: mkdir -p <vault>/<entity-slug-parent>/
  Write: <vault>/<entity-slug>.md   ← compose: frontmatter + State + Timeline (this run's entry as the only entry)
  ```
- **If the entity page exists on disk** (`Read` it first to get current content):
  ```
  Read: <vault>/<entity-slug>.md
  Edit: insert your new dated timeline entry into the file
  ```
  Place the new entry under the `<!-- timeline -->` separator, **at the top** (newest first). Do NOT rewrite the State section, do NOT modify frontmatter, do NOT touch any line outside the timeline section.

  Timeline-entry format (single line):
  ```
  - **YYYY-MM-DD** — <one-line summary>. [Source: ...]
  ```

- **Iron Law back-links**: include a wikilink `[[<destination_slug>|<destination_title>]]` in the entity page's body where contextually appropriate (typically inside the new timeline entry, or in a "Related" section). Sync's auto-link post-hook will materialize the typed link.

  **Do NOT use `gbrain link`** — DB-only.

### 2h. Preserve raw source (writes a real file in the brain repo's `.raw/` sidecar)

```bash
gbrain files upload-raw <abs_path_to_inbox_file> --page <destination_slug> --type <article|capture|transcript|...>
```

Routes <100MB to the brain repo's `.raw/` sidecar (a real file on disk); larger payloads go to cloud storage with a `.redirect.yaml` pointer. **Note:** `gbrain files upload-raw` rejects filenames with a leading underscore. If your inbox file starts with `_`, copy it to a sanitized name first, then upload, then clean up the temp copy.

### 2i. Log the ingest event (DB-only, audit trail)

```bash
gbrain call log_ingest '{
  "source_type": "inbox",
  "source_ref": "<abs path of the inbox file>",
  "pages_updated": ["<destination_slug>", "<entity_slug>", "..."],
  "summary": "<classification> -> <destination_slug>"
}'
```

DB-only is fine here — `log_ingest` is an audit trail, not a brain page. Survives sync because it's a separate table.

### 2j. Clean up the inbox file

**On success:** delete the original file:

```bash
rm <abs path of the inbox file>
```

**On failure** (classification ambiguous, content unparseable, mid-flight error you cannot recover from): move to quarantine:

```bash
mkdir -p /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/_failed
mv <abs path of the inbox file> /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/_failed/<basename>
printf 'reason: %s\ntimestamp: %s\n' "<short reason>" "$(date -u +%FT%TZ)" \
  > /mnt/c/Users/vinod/Documents/Notes/vin-notes/inbox/_failed/<basename>.error
```

Continue to the next file — never let one failure abort the batch.

## Step 3 — Write the daily digest (FILESYSTEM)

After all files this tick are processed, write or append a digest at:

```
<vault>/reports/inbox-ingest/<YYYY-MM-DD>.md
```

If the file does not exist (`Read` returns "file not found"), `Write` it:

```markdown
---
type: report
title: Inbox Ingest <YYYY-MM-DD>
tags: [inbox, ingest, automated]
---

# Inbox Ingest — <YYYY-MM-DD>

## Run @ <ISO timestamp>

Total: N · OK: K · Failed: F.

### Promoted

- **<source filename>** → `[[<destination_slug>|<title>]]` (linked: `<entity_slug>`, ...)

### Failed (see `inbox/_failed/`)

- **<source filename>** — <reason>
```

If the file ALREADY exists, `Read` it first, then `Edit` to **append** a new `## Run @ <HH:MM:SS>` section at the bottom. Don't overwrite earlier runs in the same day.

## Constraints

- **Do NOT** call `gbrain put`, `gbrain link`, or `gbrain timeline-add`. Those write to the gbrain DB only and orphan on the next sync tick. Use `Write` / `Edit` to write actual files in the vault.
- **Do NOT** call `gbrain sync` — sync runs on its own cron; the next sync tick will index your new files.
- **Do NOT** touch files outside `<vault>/inbox/`, the canonical destinations you compute, the entity pages they affect, and the digest.
- **Do NOT** use `ANTHROPIC_API_KEY` — your auth is whatever the agent platform provides.
- **Do** quote operator's own words verbatim when capturing their thinking.
- **Do** prefer updating an existing canonical page over creating a sibling.
- **Do** match existing namespace conventions (search before inventing new directory layouts).

## Anti-patterns

- Calling `gbrain put` to "save" a new page — it goes into the DB only and disappears on next sync.
- Calling `gbrain timeline-add` on an existing page — DB-only; the timeline entry is gone on next sync. Use `Edit` to insert one line under `<!-- timeline -->` instead.
- Re-writing an entity page's full content when adding a single timeline entry.
- Filing by format (article → `articles/`) instead of by subject (article about Alice → `entities/people/alice-example`).
- Skipping the raw-source upload — provenance is non-negotiable. (If `_`-prefix bug bites, copy to a sanitized name first.)
- Letting one bad file abort the whole batch.
- Inventing facts not present in the source. If you don't know, say "unknown" or omit.
- Inventing namespace conventions. Always search first.
