# CRM Futures — VennFactory Notion + n8n Roadmap

Working document for planning future CRM automation improvements.
Last updated: 2026-03-02

---

## Current Baseline

Before scoping new work, here is what the automation layer already handles:

| Capability | Workflow | Trigger |
|---|---|---|
| Contact create/update | `upsert-contact` (sub-workflow) | Called by other workflows |
| Email activity logging + AI summary | `email-activity-log` | Schedule (hourly) |
| Stale pipeline alerts → VF Tasks + AI next step | `stale-pipeline-alerts` | Schedule (daily 7 AM) |
| Auto-close stale task when Status changes | `close-stale-task` (sub-workflow) | Webhook (status property change) |
| Notion webhook routing | `notion-webhook-router` (server) | Webhook (all subscribed DBs) |
| Appearances management | External workflow | Webhook (Appearances DB) |
| Contact sync from Notion | External workflow | Webhook (Contacts DB) |

**Three active pipelines:**
- **Sales** — prospects and deal stages through to signed/lost
- **Superfriend (Partner)** — partnership development pipeline
- **Comms (Appearances)** — media appearances, speaking, PR placements

---

## Prioritization Key

**Value** — impact on relationship quality, revenue, or time saved (1–5)
**Effort** — implementation complexity given current infrastructure (1–5, lower = easier)
**Priority tier:** V − E score, where high value + low effort items rise to the top

---

## Ranked Roadmap

### 🟢 Tier 1 — Quick Wins (High Value, Low Effort)

---

#### 1. Last Contacted Date on Contacts
**Value: 5 | Effort: 2**

Update a `Last Contacted` date property on the Contacts page every time an email activity is logged for that contact. This single field transforms the contacts database into a living relationship ledger — at a glance you can see which relationships are warm vs. going cold.

**Why it matters:** The contacts database is currently append-only from the automation side. Without recency signals, there is no way to distinguish a newly-onboarded contact from a relationship that hasn't been touched in 18 months.

**Implementation:** Add a final step to `email-activity-log.js`. After creating the activity page, use the `contact_page_id` (already resolved during matching) to PATCH `Last Contacted` → today's date. One extra HTTP call per email, no new infrastructure required.

**Depends on:** `email-activity-log.js` (already built, just needs the write-back step)

---

#### 2. Follow-Up Task on Stage Advance
**Value: 4 | Effort: 2**

When a deal advances to a specific stage (e.g., Proposal Sent, Contract Sent, Intro Call Booked), automatically create a VF Task with a stage-appropriate prompt and a deadline of N days.

Examples:
- Sales → "Proposal Sent": create "Follow up on proposal" due in 5 business days
- Comms → "Confirmed": create "Prepare appearance brief" due 7 days before event date
- Superfriend → "Intro Call Done": create "Send partnership overview deck" due in 3 days

**Why it matters:** The current task system creates tasks when deals go *stale* (reactive). This creates tasks *proactively* the moment a deal reaches a key stage — before anything can go stale.

**Implementation:** New sub-workflow `stage-advance-tasks.js` triggered from the webhook router when Status changes. A lookup table maps `(pipeline, new_status) → task_template`. Shares the VF Tasks creation pattern from `stale-pipeline-alerts.js`. The webhook router already receives Status changes via `updated_properties`.

**Depends on:** `close-stale-task.js` pattern, webhook router (already updated)

---

#### 3. Weekly Pipeline Summary Report
**Value: 4 | Effort: 2**

A Monday-morning scheduled workflow that assembles a pipeline health snapshot and writes it to a pinned Notion page (or emails it). Content:

- Deals per stage across all three pipelines
- New deals added this week
- Deals that closed (won or terminal) this week
- Current stale count (deals with open tasks)
- Open VF Tasks linked to pipelines, sorted by due date

**Why it matters:** The daily stale alert creates tasks but there's no weekly rollup that lets the business owner see the whole picture at once. A Monday summary replaces the need to manually open three pipeline views.

**Implementation:** New workflow `weekly-pipeline-summary.js`. Monday 7 AM trigger. Fetches all three pipelines via Notion node getAll (existing pattern). Aggregates counts in a Code node. Writes a structured Notion page using the blocks API. No external services needed.

**Depends on:** Existing pipeline DB IDs and Notion credential

---

#### 4. Won/Lost Outcome Log
**Value: 3 | Effort: 2**

When a deal reaches a terminal status (Lost/rejected, Completed, Signed 100%, etc.), automatically create a structured outcome record in a lightweight log — either the Activities DB or a dedicated Outcomes table. Captures: deal name, pipeline, final status, days in pipeline, and outcome date.

**Why it matters:** There is currently no structured record of what happened to closed deals. Over time this data powers win-rate analysis, average deal velocity, and seasonal patterns — all of which inform better forecasting and prioritization.

**Implementation:** New sub-workflow `log-deal-outcome.js`. Triggered from the webhook router when Status changes to a terminal value. Check the list of terminal statuses (already defined in `stale-pipeline-alerts.js`). Calculate days-in-pipeline by comparing `created_time` to `last_edited_time`. Write one record to the Activities DB or a new Outcomes page.

**Depends on:** Webhook router (updated), Activities DB

---

### 🟡 Tier 2 — High Value, Medium Effort

---

#### 5. Stale Contact Re-engagement Alerts
**Value: 4 | Effort: 2**

Mirror of `stale-pipeline-alerts.js` but for the Contacts database. Contacts who haven't been reached (no email activity) in 30/60/90 days get a VF Task: "Reconnect with [Name]." Threshold varies by contact category (client vs. prospect vs. partner).

**Why it matters:** Relationship businesses live or die by consistent outreach. The pipeline alerts handle active deals; this handles everyone else — the warm introductions, past clients, and dormant prospects that could become future deals.

**Implementation:** New workflow `stale-contact-alerts.js`. Query Contacts DB for records where `Last Contacted` (see #1) is older than threshold. Cross-reference against open VF Tasks to avoid duplicates. Creates VF Tasks linked to the contact. Largely parallel to the existing stale pipeline pattern.

**Depends on:** #1 (Last Contacted date must be populated first)

---

#### 6. Activity Feed on Deal Pages
**Value: 4 | Effort: 3**

When an email activity is logged for a contact, look up whether that contact is related to any open deals, and if so, append a brief note block to those deal pages: "📧 [Date] — [Subject] — [AI summary]."

**Why it matters:** Currently the Activities DB is disconnected from the pipeline pages. Opening a deal page shows no history of what's been communicated. Adding a live activity feed to the deal page body makes the pipeline genuinely self-documenting.

**Implementation:** Extend `email-activity-log.js` with a final branch that:
1. Looks up the contact's relations to deal pages via raw Notion API (contact → relation property)
2. Appends a paragraph block to each linked deal page via PATCH /blocks/{pageId}/children

The tricky part is the contact → deal relation lookup, which requires a raw API call. Medium effort due to the additional join logic.

**Depends on:** Contact → deal relation properties being maintained in Notion

---

#### 7. Stage Duration Tracking
**Value: 3 | Effort: 3**

Log a timestamped event each time a deal's Status changes: `(deal_id, pipeline, from_stage, to_stage, timestamp)`. Over time this builds a stage-transition history that can reveal where deals get stuck.

**Why it matters:** The weekly summary (#3) can show current stage distribution, but can't answer "how long do deals typically sit in 'Proposal Sent' before moving?" Stage duration data answers that.

**Implementation:** New sub-workflow `log-stage-change.js`. Triggered from the webhook router on Status changes (same entry point as `close-stale-task.js`). Reads the current status from the webhook payload. Needs the *previous* status — this is the hard part. Options: (a) fetch the page history from Notion API (limited), or (b) maintain a "Previous Status" property on deal pages updated by this workflow. Option (b) is more reliable.

**Depends on:** Webhook router (updated), Activities DB or new Stage History DB

---

#### 8. Appearance Preparation Checklist
**Value: 3 | Effort: 3**

Specific to the Comms/Appearances pipeline: when an appearance moves to "Confirmed" status, automatically generate a standard preparation checklist as VF Tasks. Example items: logistics confirmed, tech check scheduled, pre-event brief prepared, social media post drafted, post-event thank you scheduled.

**Why it matters:** Every confirmed appearance involves the same 5–8 preparation steps. Currently those are created manually each time. Automating the checklist creation on confirmation saves significant recurring effort and ensures nothing gets missed.

**Implementation:** Extension of the `stage-advance-tasks.js` concept (#2), but creates multiple tasks for a single trigger event. Each task has its own due date relative to the event date (requires reading the event date from the Appearances page). Medium effort due to multi-task creation logic and date-relative scheduling.

**Depends on:** #2 (stage-advance-tasks pattern), event date property on Appearances DB

---

#### 9. Real-Time Duplicate Detection on Contact Update
**Value: 3 | Effort: 3**

When a contact update arrives in `contact-updates-from-notion` (the sub-workflow called by the webhook router), query the Contacts DB for all pages with the same email before syncing to Mailchimp. If more than one record exists, flag the contact and skip the Mailchimp sync until the duplicate is resolved.

**Why it matters:** Duplicates created from multiple entry points (form fills, email log matching, manual entry) currently flow straight into Mailchimp as separate records, splitting email history and creating inconsistent merge-field data. Catching duplicates at the moment of update — rather than in a weekly sweep — prevents the downstream contamination before it happens.

**Implementation (two steps):**

1. **Step 1 — Detection + flagging (low effort, do first):** After the email filter in `contact-updates-from-notion`, add a Notion query for all contacts with matching email. If `results.length > 1`, branch to a flag node: PATCH the contact with a `⚠️ Needs Review` tag and exit without calling Mailchimp. 4 additional nodes, no destructive actions.

2. **Step 2 — Inline merge (medium effort, separate build):** Refactor `merge-duplicate-contacts.js` to expose the per-group merge as a callable sub-workflow (`merge-contact-group.js`) that accepts a list of page IDs and handles one duplicate group at a time. Wire it into the detection branch from Step 1 to replace the flag-and-skip with an actual merge on detection.

**Risks:** Step 2 introduces a race condition risk if two webhook events fire concurrently for the same email during a bulk import. Mitigation: Step 1's flag-and-skip is safe to ship immediately; Step 2 should include a dedup guard (check if a VF Task for this merge already exists before executing).

**Depends on:** `contact-updates-from-notion` (existing), `merge-duplicate-contacts.js` (existing, needs refactor for Step 2)

---

### 🔵 Tier 3 — Valuable but More Complex

---

#### 9. AI Deal Health Score
**Value: 4 | Effort: 4**

A composite per-deal score (0–100) that factors in: days in current stage, activity recency, number of activities this month, distance from stale threshold, deal age. Updated daily via a scheduled workflow and written back to a `Health Score` number property on each deal page.

**Why it matters:** Rather than just flagging stale deals, a health score gives a continuous signal that can be used to sort/filter pipeline views in Notion. A deal at 85 is fine; one at 20 needs attention today.

**Implementation:** New workflow `deal-health-score.js`. Daily schedule. For each deal: calculate component scores in a Code node using last_edited_time, activity count from Activities DB (query by contact relation), stage-time if tracking stage duration (#7). Write back via Notion PATCH. Most complexity is in the Activity DB join and scoring formula design.

**Depends on:** Activities DB being populated, #7 (stage duration) for best results

---

#### 10. Calendar Meeting Auto-Log
**Value: 3 | Effort: 3**

When a meeting occurs on Eve's calendar with a known contact (matched by email), automatically create an Activity record in Notion with: meeting date, subject, attendees, and optionally an AI-generated summary of the meeting notes if notes are attached.

**Why it matters:** Email is only one channel. Meetings are often more significant touchpoints than emails and should be captured in the activity log. Currently they are invisible to the CRM unless manually logged.

**Implementation:** New workflow `calendar-activity-log.js`. Uses Microsoft Graph API (same OAuth credential as email) to read calendar events from the past 24 hours. Match attendees to contacts by email. Create activity records with type = "Meeting". Similar dedup pattern to `email-activity-log.js`. Effort is medium because the MS Graph calendar API is straightforward but attendee-to-contact matching adds complexity.

**Depends on:** Outlook/Microsoft 365 OAuth credential (same as email log, already needed)

---

#### 11. Video Call Activity Log (Zoom / Teams)
**Value: 4 | Effort: 4**

When a video call ends with a known contact, automatically create an Activity record in Notion — including participant list, duration, and an AI-generated summary of the transcript if cloud recording/transcription is enabled.

**Why it matters:** For a speaker, podcast guest, and business development business, video calls are often the *most* significant touchpoints — the ones where relationships actually advance. Calendar logging (#10) only records that a meeting existed. This captures what was discussed, making the CRM genuinely reflective of real conversations rather than just email threads.

**Implementation:** Two viable entry points depending on the platform in use:

- **Zoom:** Subscribe to the `meeting.ended` webhook. Fetch participant emails via `GET /report/meetings/{meetingId}/participants`. If cloud recording is enabled, poll `GET /recordings/{meetingId}` for the transcript VTT file. Match participant emails to Contacts DB, create Activity record, pass transcript excerpt to Haiku for a 2–3 bullet summary.
- **Microsoft Teams:** Use the MS Graph API already authorized via the M365 credential. Poll `GET /communications/callRecords` (filter to last 24 hours). Fetch transcripts via `GET /onlineMeetings/{id}/transcripts` (requires transcription to be enabled in Teams admin). Same matching and summarization pattern.

Either path creates Activity records with `type = "Video Call"` and links to the relevant contact pages, using the same dedup-by-external-ID pattern as `email-activity-log.js`.

**Relationship to #10:** Calendar Auto-Log (#10) and this item are complementary, not redundant. #10 captures *all* calendar events (including those without a call link) based on attendee email. This captures call *content* from the platform. Building #10 first establishes the contact-matching and activity-creation patterns; this item then extends them with richer payload handling.

**Depends on:** #10 (Calendar Meeting Auto-Log) for patterns, Zoom webhook credential or M365 OAuth (existing), cloud recording/transcription enabled on the relevant platform

---

#### 12. Contact Enrichment on Create
**Value: 3 | Effort: 4**

When a new contact is created in the Contacts DB (webhook trigger), automatically attempt to enrich missing fields: company website, LinkedIn URL, job title, company size. Options: Clearbit Enrichment API (paid), Hunter.io (email verification + company info), or an AI web search prompt that looks up the person.

**Why it matters:** Contacts created via form fills or manual entry often have only name + email. Enrichment turns a stub into a useful record — enabling better segmentation, personalization, and routing.

**Implementation:** New sub-workflow `enrich-contact.js`. Triggered from the Contacts DB webhook path in the router. Call enrichment API with email address. Map returned fields to Notion properties and PATCH the contact page. Main challenge: API cost management (only enrich if fields are missing) and graceful fallback when the person isn't found.

**Depends on:** Webhook router (Contacts path already active), enrichment API key

---

#### 13. Automated Deal-Won Onboarding
**Value: 3 | Effort: 4**

When a Sales deal moves to "Signed 100%" (or equivalent win status), automatically kick off a standard onboarding sequence: welcome email draft created, kickoff meeting VF Task created, contract checklist created, and the contact's "Client DB" relation updated to link them to a new Engagement record.

**Why it matters:** The moment a deal closes is time-sensitive — the buyer is at peak excitement. Automating the first 24-hour onboarding actions ensures a consistent, professional handoff and frees the business owner from a mentally-loaded checklist.

**Implementation:** New workflow `deal-won-onboarding.js`. Triggered from the webhook router when Sales Status changes to "Signed 100%". Creates 3–5 VF Tasks using the standard task creation pattern. Optionally creates a new Engagement page in the Clients DB and links the contact. Most effort is in designing the task templates and the Engagement page creation logic.

**Depends on:** #2 (stage-advance-tasks pattern), Clients DB structure

---

#### 14. Contact Deduplication Sweep
**Value: 2 | Effort: 4**

A weekly workflow that scans the Contacts DB for potential duplicates: contacts sharing the same email, or contacts with similar names at the same company. Creates a VF Task with a list of suspected duplicates for manual review rather than auto-merging.

**Why it matters:** Over time, contacts entered from multiple sources (forms, manual entry, email log matching) accumulate duplicates that pollute the database and split activity history. Periodic detection keeps the database clean without requiring schema changes.

**Implementation:** New workflow `dedup-contacts.js`. Weekly schedule. Fetch all contacts. In a Code node, build a map of email → contact IDs and flag any email appearing more than once. For name-based matching, use normalized string comparison. Output a report to a Notion page or create one VF Task listing all suspected pairs. Effort: medium-high due to the fuzzy matching logic.

**Depends on:** Contacts DB being well-populated

---

### ⚪ Tier 4 — Nice to Have (Specialized or Lower ROI)

---

#### 14. Cross-Pipeline Analytics Dashboard
**Value: 4 | Effort: 5**

A dedicated Notion database or Notion page updated daily with structured analytics across all pipelines: conversion rates by stage, average deal velocity, win/loss ratios by period, revenue pipeline value (if deal values are tracked), and trend sparklines.

**Why it matters:** The highest-value CRM insight is trend data — not just "what is the pipeline today" but "is it improving or degrading over time." A dashboard makes this visible without requiring any manual reporting.

**Note:** This is last because it depends on several upstream data sources (#7 stage duration, #4 outcome log, #9 health score) being in place first. Building the dashboard before the data exists produces an empty shell. Build the data layer first.

**Depends on:** #4, #7, and ideally #9

---

#### 15. LinkedIn Activity Logging
**Value: 2 | Effort: 5**

Log LinkedIn messages and connection requests as activity records. LinkedIn's official API does not expose messaging, so this requires either a third-party integration (Phantombuster, Make/Zapier LinkedIn connector) or browser automation.

**Note:** Lowest priority due to API limitations and the complexity of the integration relative to value. Most business-critical communication is already captured via email (#email-activity-log). Revisit if LinkedIn becomes a primary outreach channel.

---

## Summary Matrix

| # | Capability | Value | Effort | Tier |
|---|---|:---:|:---:|:---:|
| 1 | Last Contacted date on contacts | 5 | 2 | 🟢 |
| 2 | Follow-up task on stage advance | 4 | 2 | 🟢 |
| 3 | Weekly pipeline summary | 4 | 2 | 🟢 |
| 4 | Won/lost outcome log | 3 | 2 | 🟢 |
| 5 | Stale contact re-engagement alerts | 4 | 2 | 🟡 |
| 6 | Activity feed on deal pages | 4 | 3 | 🟡 |
| 7 | Stage duration tracking | 3 | 3 | 🟡 |
| 8 | Appearance preparation checklist | 3 | 3 | 🟡 |
| 9 | Real-time duplicate detection on contact update | 3 | 3 | 🟡 |
| 10 | AI deal health score | 4 | 4 | 🔵 |
| 11 | Calendar meeting auto-log | 3 | 3 | 🔵 |
| 12 | Video call activity log (Zoom / Teams) | 4 | 4 | 🔵 |
| 13 | Contact enrichment on create | 3 | 4 | 🔵 |
| 14 | Deal-won onboarding sequence | 3 | 4 | 🔵 |
| 15 | Contact dedup sweep | 2 | 4 | 🔵 |
| 16 | Cross-pipeline analytics dashboard | 4 | 5 | ⚪ |
| 17 | LinkedIn activity logging | 2 | 5 | ⚪ |

---

## Recommended Build Order

Given the dependencies, the most efficient sequence is:

1. **#1 Last Contacted** — unlocks #5 (stale contacts), adds to #6 (activity feed), feeds #9 (health score)
2. **#4 Won/Lost Log** — quick win, standalone, starts building outcome data
3. **#3 Weekly Summary** — standalone, high perceived value for minimal effort
4. **#2 Stage-Advance Tasks** — builds on the webhook patterns just established
5. **#8 Appearance Checklist** — natural extension of #2 for the Comms pipeline
6. **#5 Stale Contact Alerts** — depends on #1 being live for at least a few weeks
7. **#7 Stage Duration** — data collection; starts being useful once a few weeks of data accumulate
8. **#6 Activity Feed on Deals** — most impactful quality-of-life improvement; do after #1 and #7
9. **#11 Calendar Meeting Log** — extends the activity log; requires MS Graph credential
10. **#12 Video Call Activity Log** — natural extension of #11; add Zoom or Teams credential and enable cloud transcription first
11. **#10 Health Score** — most powerful once #1, #4, #7 are providing data
12. **#13–#15** — as time and value warrant

---

*Document maintained in `/Users/eli/Documents/N8N/CRM-futures.md`*
