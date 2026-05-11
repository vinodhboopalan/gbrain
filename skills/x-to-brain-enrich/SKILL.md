---
name: x-to-brain-enrich
version: 1.0.0
description: |
  On-demand enrichment of X tweets collected to ~/x-collector/data/. Reads
  per-tweet JSON files (own timeline + mentions), applies the brain's
  notability gate, and promotes substantive content into canonical brain
  pages with Iron Law back-links and source citations. Marks each tweet
  with `_enriched_at` to skip on subsequent runs. Companion to the
  `inbox-to-brain` skill — same protocol, different source.
triggers:
  - "process my x captures"
  - "enrich x tweets"
  - "promote x tweets to brain"
  - "run x-to-brain-enrich"
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
  - entities/
  - references/
  - reports/x-enrichment/
---

# X-to-Brain Enrichment Skill

Your job: read the X tweets the collector has stored on disk, decide which
ones are notable per the brain filing rules, and promote them to canonical
brain pages. The collector (`~/x-collector/collect.mjs`) handles data
acquisition (deterministic, no LLM calls). This skill handles judgment
(notability, entity detection, filing decisions).

> **Read first:** `<gbrain>/skills/_brain-filing-rules.md` and
> `<gbrain>/skills/ingest/SKILL.md`. The protocol here is identical to
> `inbox-to-brain` — only the source changes (X JSON files vs vault inbox
> markdown files).

> **Write FILES, not DB rows.** Same Iron Law as `inbox-to-brain`. Use
> `Write` / `Edit` against the vault filesystem. Sync's auto-link post-hook
> picks up wikilinks on the next 5-min tick. **Do NOT** call `gbrain put`,
> `gbrain link`, or `gbrain timeline-add` — they're DB-only and orphan on
> next sync.

## Paths

- Vault root: `/mnt/c/Users/vinod/Documents/Notes/vin-notes`
- gbrain repo: `/home/itadmin/gbrain`
- Collector data: `~/x-collector/data/`
  - `tweets/<id>.json` — own timeline (originals, retweets, replies, quotes)
  - `mentions/<id>.json` — @-mentions of the user by others
  - `deletions/<id>.json` — tweets that disappeared from the timeline
- Digest target: `<vault>/reports/x-enrichment/<YYYY-MM-DD>.md`

## Step 0 — Environment

```bash
export PATH="$HOME/.bun/bin:$PATH"
set -a && . "$HOME/.gbrain/.env" && set +a
```

## Step 1 — Enumerate unenriched tweets

```bash
# Each tweet's JSON has _enriched_at IFF it's been processed before.
# This pulls every tweet missing that field, oldest first.
find ~/x-collector/data/tweets ~/x-collector/data/mentions -name '*.json' -print0 | \
  xargs -0 jq -r 'select(._enriched_at == null) | [._collected_at, input_filename] | @tsv' | \
  sort
```

If the listing is empty, log a single line `no unenriched x tweets, exiting`
and stop. Do not write a digest.

## Step 2 — Per-tweet processing (serial, oldest first)

For each tweet file, in order:

### 2a. Read the tweet

```
Read tool → full JSON
```

Extract: `id`, `text`, `author.userName`, `createdAt`, `likeCount`,
`replyCount`, `retweetCount`, `quoteCount`, and any `entities.urls[]`,
`entities.mentions[]`. Note whether `retweeted_tweet` is set (RT) or this
is an original.

### 2b. Classify

One of:
- `original` — your own tweet, not a reply or RT.
- `reply` — your reply to someone (`text` starts with `@handle`).
- `retweet` — `retweeted_tweet` field present; the substance is the original.
- `quote` — `quoted_tweet` field present; both your commentary and the original matter.
- `mention` — only present in `mentions/`; someone @-mentioning you.

### 2c. Apply the notability gate

**Skip enrichment** (mark `_enriched_at` + `_enrichment_decision: "skipped"`,
no brain pages written) when ANY:

- The tweet body is just a URL (`https://t.co/...`) with no commentary.
- The tweet is < 80 characters AND has no entity references AND zero
  engagement on substance (e.g. "I love @grok!! 😀").
- The tweet is an @-mention to a corporate support handle (`@TataMotors`,
  `@SupportApp`) — these are customer-service captures, not brain content.

**Enrich** when ANY:

- Original tweet ≥ 80 chars OR contains 2+ entity references.
- RT/quote where the original tweet has substantive thinking
  (philosophical, technical, founder/operator commentary).
- Mention from a notable account (existing brain page, or follower count
  ≥ 10K, or substantive content).

### 2d. Decide canonical destination

Per `<gbrain>/skills/_brain-filing-rules.md`: **file by primary subject**.

Concrete decision tree for X tweets:

| Type | Substance | Destination |
|---|---|---|
| original | philosophy / framework | `concepts/<slug>` |
| original | about a person on existing brain page | `entities/people/<slug>` (timeline entry) |
| original | about a company | `entities/companies/<slug>` (timeline entry) |
| reply | substantive thread | `entities/people/<other-handle>` (timeline entry on the person you replied to) |
| retweet | substantive third-party thinking | `references/<slug>` + timeline on `entities/people/<rt-author>` |
| quote | your commentary on someone else | `entities/people/<quoted-author>` (timeline entry, capture both sides) |
| mention | someone notable @-mentioned you | `entities/people/<mentioner>` (timeline entry) |

**Always update the author's entity page** (yours for originals, the RT'd
person's for retweets) regardless of whether a standalone reference page
also gets created. Iron Law back-links are non-negotiable.

### 2e. Compose the canonical page (or timeline entry)

For a **standalone page** (concepts/, references/):

```yaml
---
type: concept | reference
title: <human title — not the first 60 chars of the tweet>
tags: [x-source, <topic-tags>]
source: x
source_url: https://x.com/<handle>/status/<tweet_id>
captured_at: <ISO from _collected_at>
---

<state — your synthesis of what the tweet says, NOT the verbatim text
unless it's the operator's own thinking, in which case quote verbatim>

[Source: X/@<handle>, <YYYY-MM-DD>](https://x.com/<handle>/status/<id>)

<!-- timeline -->

- **<YYYY-MM-DD>** — Tweeted: "<tweet text up to ~200 chars>". [Source: X/@<handle>, <YYYY-MM-DD>]
```

For a **timeline entry on an existing entity page**: read the page first
via `Read`, then `Edit` to insert ONE line under `<!-- timeline -->`,
newest first. Do NOT rewrite State, frontmatter, or anything outside the
timeline section.

```
- **<YYYY-MM-DD>** — Tweeted/RT'd: "<one-line summary>" [[Tweet]](https://x.com/<handle>/status/<id>) [Source: X/@<handle>, <YYYY-MM-DD>]
```

**Wikilinks for cross-references**: `[[entities/people/elon-musk|Elon Musk]]`
in the body where contextually appropriate. Sync's auto-link post-hook
materializes the typed `link` rows on its next tick.

### 2f. Write the page (FILESYSTEM)

```
Bash: mkdir -p <vault>/<slug-parent>/
Write: <vault>/<slug>.md   ← composed content
```

For timeline-only updates on existing pages:

```
Read: <vault>/<slug>.md
Edit: insert one line under <!-- timeline --> at the top (newest first)
```

### 2g. Mark the tweet as enriched

Update the JSON file in place, **preserving every existing field** (the
collector preserves any `_enrich*` field across re-runs):

```bash
jq '. + {
  _enriched_at: "<ISO now>",
  _enrichment_decision: "<filed|skipped>",
  _enrichment_destinations: ["<slug1>","<slug2>"]
}' ~/x-collector/data/tweets/<id>.json > ~/x-collector/data/tweets/<id>.json.tmp \
  && mv ~/x-collector/data/tweets/<id>.json.tmp ~/x-collector/data/tweets/<id>.json
```

`_enrichment_decision` MUST be one of: `filed`, `skipped`, `deferred`.
`_enrichment_destinations` is the list of brain slugs you wrote to (or `[]`
for skipped).

### 2h. Log the ingest event

```bash
gbrain call log_ingest '{
  "source_type": "x",
  "source_ref": "x:<tweet_id>",
  "pages_updated": ["<slug1>","<slug2>"],
  "summary": "<classification> -> <destinations>"
}'
```

DB-only is fine here — `log_ingest` is an audit trail, not a brain page.

## Step 3 — Write the daily digest

After all tweets this run are processed, write or append at:

```
<vault>/reports/x-enrichment/<YYYY-MM-DD>.md
```

Pattern matches `inbox-to-brain`'s digest:

```markdown
---
type: report
title: X Enrichment <YYYY-MM-DD>
tags: [x, enrichment, automated]
---

# X Enrichment — <YYYY-MM-DD>

## Run @ <ISO timestamp>

Total: N · Filed: K · Skipped: S · Deferred: D.

### Filed

- **<tweet_id>** by @<handle>: "<text excerpt>" → `[[<slug>|<title>]]`
- ...

### Skipped (notability gate)

- **<tweet_id>** by @<handle>: <one-word reason — "url-only", "too-short", "support-mention">
- ...

### Deferred (need human eyes)

- **<tweet_id>** by @<handle>: "<text excerpt>" — <reason>
- ...
```

Append `## Run @` sections to existing same-day digests rather than
overwriting.

## Constraints

- **Do NOT** call `gbrain put`, `gbrain link`, or `gbrain timeline-add`. Vault
  filesystem is the source of truth; sync rebuilds from disk.
- **Do NOT** call `gbrain sync` — sync runs on its own cron.
- **Do NOT** modify `~/x-collector/data/tweets/<id>.json` fields other than
  the `_enrich*` family. Collector owns everything else.
- **Do NOT** re-process a tweet whose `_enriched_at` is already set, even if
  it looks like a re-classification might apply. Operators can clear the
  field manually to force a re-run.
- **Do NOT** invent facts. If a tweet is ambiguous, mark it `deferred` and
  surface it in the digest for human review rather than guessing.
- **Do** quote operator's (your) own words verbatim — your phrasing IS the
  insight.
- **Do** prefer updating an existing entity page over creating a sibling.
- **Do** strip URL trackers (`?si=...`, `?utm_*`) before storing source URLs.

## Anti-patterns

- Writing brain pages for every tweet without notability gating — turns the
  brain into a tweet archive, defeats the point.
- Filing by author handle rather than primary subject ("a tweet about
  scaling laws by @karpathy" goes under `concepts/scaling-laws`, not
  `entities/people/karpathy`).
- Writing the verbatim tweet text as the State section. State is YOUR
  synthesis; the tweet text belongs in the Source citation + timeline.
- Skipping the `_enriched_at` write — re-runs will reprocess the same tweet
  and double-write timeline entries.
- Treating retweets as the user's own thinking. The substance is the
  original tweet's; the user's contribution is the curation choice.

## Re-running the skill

The skill is idempotent: re-running it after `_enriched_at` is set on every
tweet will exit with `no unenriched x tweets, exiting`. To force a re-run
on a specific tweet, clear its `_enriched_at` field:

```bash
jq 'del(._enriched_at) | del(._enrichment_decision) | del(._enrichment_destinations)' \
  ~/x-collector/data/tweets/<id>.json > /tmp/tweet.json && \
  mv /tmp/tweet.json ~/x-collector/data/tweets/<id>.json
```
