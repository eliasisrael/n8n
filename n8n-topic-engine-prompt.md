# Build Prompt: LinkedIn Daily Topic Engine (n8n)
*For use with Claude Code in an n8n project*
*LLM: Claude Sonnet 4.6 | Storage: Dropbox | Schedule: Daily*

---

## Context

Build an n8n workflow that generates a daily digest of 3 ranked and framed LinkedIn post topic candidates for Eli Israel, Managing Partner at Gartner. Eli's content focuses on developer productivity, AI in software development, platform engineering, and challenging oversimplified tech narratives. His voice is direct, analytically grounded, anti-hype, and pro-practitioner.

The workflow reads from and writes to a Dropbox folder at the path:

```
/Content-Creation/
├── 0-Topics/
│   ├── topics-log.csv          ← read for deduplication; append when topics are surfaced
│   └── YYYY-MM-DD_daily-topics.md  ← write daily output here
```

The topics-log.csv has these columns: `date, title, theme, format, status, source, notes`

---

## Workflow Overview

The workflow has four stages that run in sequence each day:

1. **Source Collection** — pull items from multiple sources in parallel
2. **Filter** — freshness, relevance (LLM), and novelty (vs. topics-log)
3. **Rank** — score survivors by engagement velocity, topic fit, and angle availability
4. **Frame & Output** — generate angles for top candidates; write digest to Dropbox

---

## Stage 1: Source Collection

Trigger on a daily schedule (suggested: 7:00 AM CT).

Pull from the following sources in parallel using HTTP Request nodes. Normalize each item into this structure before merging:

```json
{
  "id": "unique string (url or reddit post id)",
  "title": "string",
  "url": "string",
  "source": "string (e.g. 'reddit/ExperiencedDevs')",
  "published_at": "ISO 8601 timestamp",
  "engagement_score": "number (upvotes, points, or 0 if unavailable)",
  "summary": "string (selftext, description, or empty string)"
}
```

### Source A: Reddit (4 subreddits)

Use the public Reddit JSON API — no authentication required.

Endpoint pattern:
```
GET https://www.reddit.com/r/{subreddit}/top.json?t=day&limit=25
```

Subreddits: `ExperiencedDevs`, `programming`, `devops`, `SoftwareEngineering`

Map fields: `data.children[].data` → title, url, created_utc (convert to ISO), score (engagement_score), selftext (summary).

### Source B: Hacker News (5 keyword queries)

Use the Algolia HN Search API — no authentication required.

Endpoint pattern:
```
GET https://hn.algolia.com/api/v1/search?query={keyword}&tags=story&numericFilters=created_at_i>{unix_timestamp_24h_ago}&hitsPerPage=10
```

Keywords: `developer productivity`, `platform engineering`, `AI coding`, `vibe coding`, `developer experience`

Map fields: `hits[]` → title, url, created_at_i (convert to ISO), points (engagement_score), story_text (summary).

### Source C: Google News RSS (4 keyword queries)

Endpoint pattern:
```
GET https://news.google.com/rss/search?q={keyword}&hl=en-US&gl=US&ceid=US:en
```

Keywords: `platform engineering`, `AI coding tools`, `developer productivity`, `enterprise AI adoption`

Parse RSS XML. Map: item.title, item.link (url), item.pubDate (published_at). Set engagement_score to 0.

### Source D: Tech RSS Feeds (2 feeds)

```
GET https://thenewstack.io/feed/
GET https://feed.infoq.com/
```

Parse RSS XML. Map: item.title, item.link, item.pubDate. Set engagement_score to 0.

### Merge & Deduplicate

After all parallel branches complete, merge into a single array. Deduplicate by URL (exact match). If two items share the same URL from different sources, keep the one with the higher engagement_score.

---

## Stage 2: Filter

Run three sequential filters. Pass survivors of each filter to the next.

### Filter 2a: Freshness

Keep only items where `published_at` is within the last 48 hours. Drop the rest.

### Filter 2b: Relevance (LLM)

Send surviving items to a Claude Sonnet 4.6 AI node in batches. Use this system prompt:

```
You are evaluating news and discussion items for relevance to a LinkedIn content creator's topic areas.

The creator is Eli Israel, Managing Partner at Gartner, focused on enterprise software teams. His five content themes are:
1. AI in Software Development — pragmatic adoption, anti-hype, Spec-Driven Development, AI coding tools
2. Developer Experience & Productivity — DX as a measurable business lever, team velocity, retention
3. Platform Engineering & DevOps — platform ownership vs. tooling accumulation, path to production
4. Challenging Tech Narratives — picking apart oversimplified charts, "AI killed X" takes, enterprise hype
5. Personal & Community — health/resilience stories, amplifying founders and operators he believes in

For each item, return a JSON array where each element has:
- "id": the item's id field (return exactly as provided)
- "score": integer 0–10 (0 = irrelevant, 10 = perfect fit for one of the themes)
- "theme": which of the 5 themes it best fits, or "none"
- "reason": one sentence

Only return the JSON array. No explanation outside it.
```

Pass the batch as a JSON array in the user message:

```
Evaluate these items:
{items_as_json_array}
```

Keep only items with score >= 6.

### Filter 2c: Novelty

Read `0-Topics/topics-log.csv` from Dropbox. Parse it. Extract the `title` column from all rows where `date` is within the last 60 days.

For each surviving item from 2b, check whether its title is substantially similar to any recent logged topic. Use simple keyword overlap as a heuristic: if 3 or more significant words (>4 chars) match between an item title and a logged topic title, flag it as a duplicate and drop it.

After this filter, you should have roughly 10–25 items remaining.

---

## Stage 3: Rank

Score each surviving item on three dimensions, combine into a final score, and take the top 5.

### Dimension 1: Engagement Velocity (0–10)

For Reddit and HN items only. Compute: `engagement_score / hours_since_published`. Normalize to 0–10 across the current batch (max velocity = 10, zero engagement = 0). RSS items score 5 (neutral — editorial selection is its own signal).

### Dimension 2: Topic Fit (0–10)

Use the relevance score from Filter 2b directly (already 0–10).

### Dimension 3: Angle Availability (0 or 3 bonus points)

Send the top 15 items by combined D1+D2 score to a Claude Sonnet 4.6 AI node with this prompt:

```
For each item below, answer whether it offers a clear contrarian, practitioner-focused, or analytically grounded angle for a LinkedIn post — the kind of take that challenges a prevailing narrative or validates what experienced engineers already know but rarely see articulated.

Answer with a JSON array. Each element:
- "id": item id (return exactly as provided)
- "has_angle": true or false
- "angle_hint": one sentence describing the angle (only if true)

Only return the JSON array.
```

Items that return `has_angle: true` get +3 added to their combined D1+D2 score.

### Final Ranking

Sort all items by (D1 + D2 + angle bonus) descending. Take the top 5 as candidates for framing.

---

## Stage 4: Frame & Output

### Framing (LLM)

Send the top 5 ranked items to a Claude Sonnet 4.6 AI node for angle generation. Use this prompt:

```
You are helping Eli Israel identify and frame LinkedIn post topics. Eli is a Managing Partner at Gartner. His voice is direct, analytically grounded, and occasionally sardonic. He challenges oversimplified tech narratives and consistently sides with practitioners — people who build and deliver — over theorists. He does not moralize. He analyzes.

His opener style: strong declarative or contrarian statement. Never a question. Never a scene-setter.

For each item below, generate:
- "draft_opener": A punchy opening line in Eli's voice (one sentence, declarative, takes a position immediately)
- "angle": One sentence describing the contrarian or practitioner take
- "suggested_format": One of: Post, Long Post, Comment, Repost
- "theme": Which of Eli's five themes this fits best

Items:
{top_5_items_as_json}

Return a JSON array. One object per item, including the original "id" field.
```

### Select Top 3

From the 5 framed items, select the top 3 by final ranking score. These become the daily digest.

### Write Daily Digest to Dropbox

Write a markdown file to Dropbox at path:

```
/Content-Creation/0-Topics/{YYYY-MM-DD}_daily-topics.md
```

Use this template:

```markdown
# Daily Topic Digest — {YYYY-MM-DD}
*Generated at {HH:MM} CT | {N} sources | {M} items evaluated*

---

## Topic 1 — {theme}
**{title}**
Source: {source} | Suggested format: {suggested_format}
URL: {url}

**Angle:** {angle}
**Draft opener:** {draft_opener}

---

## Topic 2 — {theme}
**{title}**
Source: {source} | Suggested format: {suggested_format}
URL: {url}

**Angle:** {angle}
**Draft opener:** {draft_opener}

---

## Topic 3 — {theme}
**{title}**
Source: {source} | Suggested format: {suggested_format}
URL: {url}

**Angle:** {angle}
**Draft opener:** {draft_opener}

---
*Full candidate pool: {M} items after filtering | Top 5 scored and framed | Top 3 selected*
```

### Append to topics-log.csv

For each of the 3 selected topics, append one row to `/Content-Creation/0-Topics/topics-log.csv`:

```
{YYYY-MM-DD},{title},{theme},{suggested_format},Surfaced,n8n,{angle_hint}
```

Download the current CSV from Dropbox, append the rows, and re-upload. Do not overwrite the header row.

---

## Error Handling

- If any single source fails (HTTP error, parse error), log the failure and continue with remaining sources. Do not abort the workflow.
- If fewer than 3 items survive all filters, write a digest with however many are available and include a note at the top: `⚠️ Only {N} candidates passed filtering today.`
- If the Dropbox write fails, retry once after 60 seconds.

---

## Credentials Required

- **Dropbox**: OAuth2 via n8n's built-in Dropbox credential. Scope: `files.content.read`, `files.content.write`
- **Anthropic API**: API key for Claude Sonnet 4.6. Set as an n8n credential and reference it in all AI nodes. Model string: `claude-sonnet-4-6`

---

## Notes

- The Reddit JSON API requires a `User-Agent` header. Set it to something descriptive, e.g. `n8n-topic-engine/1.0`
- Google News RSS occasionally blocks automated requests. If it fails consistently, replace with a SerpAPI Google News node or remove it — the Reddit and HN sources are higher signal anyway.
- The topics-log.csv is append-only. Never delete or overwrite existing rows.
- The workflow should be idempotent within a day — if re-run, it should overwrite the same-day digest file rather than creating a duplicate.
