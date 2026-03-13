# Webhook Router Refactor: Debounce + QStash Pub/Sub + Activity Tracking

## Context

Three interrelated needs drive this work:

1. **Debounce** — Notion fires multiple webhook events per user action (~1s apart), causing race conditions, duplicate writes, and ping-pong loops with Mailchimp. A single contact edit produces up to 19 executions across 5 workflows. (See LESSONS.md for root cause analysis.)

2. **Decoupled fan-out** — The current router uses a Switch node + Execute Workflow nodes to dispatch events. Adding a new subscriber requires patching the live router. QStash URL Groups provide pub/sub fan-out where subscribers register independently.

3. **Activity tracking** — The business needs a general-purpose activity log (email, phone, text, Signal, Slack, WhatsApp, etc.) with webhook-driven "Last Activity" updates on contacts and deals.

All three are addressed by the same architectural change to the webhook router.

---

## Current Architecture

```
Notion → Webhook Router (6kSboH0MtIOedeja)
           │
           ├─ Validate signature (HMAC-SHA256)
           ├─ Skip deleted events
           ├─ Load Referenced Page (Notion API fetch → enriched record)
           ├─ Route By Database (Switch on body.data.parent.id)
           │
           ├─ [Contacts]        → Execute Contacts Workflow (XfO5Zg1zn6A4vhD6)
           ├─ [Clients]         → Execute Clients Workflow (GMNBwXAkFWc7XhlG)
           ├─ [Partners]        → Execute Partners Workflow (G5JpSIFZSBNVM8RR)
           ├─ [Appearance/Comms]→ Execute Appearances (ceyZMOF8SKTkilhd)
           │                    → Execute Close Stale Task (EIkTeuoWsQ6fAgNO)
           │                    → Execute Stage Entry Tasks (MXmnk2bPGxMn8ROL)
           ├─ [Sales Pipeline]  → Execute Close Stale Task (EIkTeuoWsQ6fAgNO)
           │                    → Execute Stage Entry Tasks (MXmnk2bPGxMn8ROL)
           ├─ [Partner Pipeline]→ Execute Close Stale Task (EIkTeuoWsQ6fAgNO)
           │                    → Execute Stage Entry Tasks (MXmnk2bPGxMn8ROL)
           ├─ [Downloads]       → Execute Downloads (oPFK3KGX1tTItJHt)
           ├─ [Testimonials]    → Execute Testimonials (YlSBvDkZLHocJCjU)
           ├─ [Engagements]     → Execute Engagements (0VlE1zFPDaz94blF)
           ├─ [Products]        → Execute Products (MFoTZac1zXBHGdc5)
           └─ [Book Endorsem.]  → Store Book Endorsement (gmtPuFBhZ56ImCcX)
```

**15 subscriber dispatch points** across 11 databases. All subscribers receive the enriched `{ body, record }` payload where `record` contains the full Notion page in simplified output format.

---

## Target Architecture

```
Notion → Webhook Router (simplified)
           │
           ├─ Validate signature
           ├─ Skip deleted events
           ├─ Redis: SET debounce:page:{id} 1 EX 10 NX
           │    └─ If duplicate → respond 200, stop
           │
           ├─ Publish to QStash URL Group with 10s delay
           │    (topic = database name, payload = minimal event metadata)
           │
           └─ Respond 200 to Notion

           ... 10 seconds later ...

QStash → delivers to all subscriber endpoints in the URL Group
           │
           ├─ Adapter: Contacts    → [fetch page] → Execute Contacts Workflow
           ├─ Adapter: Pipelines   → [fetch page] → Execute CST + SET
           ├─ Adapter: Activities  → [fetch page] → Execute Activity Webhook
           ├─ Adapter: Appearances → [fetch page] → Execute Appearances Workflow
           └─ ... (one adapter per database)
```

**Key changes:**
- Router no longer loads pages or routes per-database — it just debounces and publishes
- QStash URL Groups handle fan-out — adding a subscriber = registering a webhook URL
- Each adapter workflow fetches **fresh** page data from Notion (10s after the burst settles)
- Existing sub-workflows remain unchanged — adapters format the `{ body, record }` payload they expect

---

## Infrastructure

### Services

| Service | Purpose | Credentials |
|---|---|---|
| Upstash Redis | Debounce gate (`SET ... NX EX 10`) | Already in `.env` (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) |
| Upstash QStash | Delayed pub/sub fan-out | **New** — needs `QSTASH_TOKEN` and signing keys added to `.env` |

### QStash API Summary

| Operation | Method | Endpoint |
|---|---|---|
| Create/add endpoints to topic | POST | `/v2/topics/{name}/endpoints` |
| Publish with delay | POST | `/v2/publish/{topicName}` + `Upstash-Delay: 10s` header |
| Verify delivery | Check `Upstash-Signature` JWT header on receiving end |

**Free tier**: 1,000 messages/day. At ~50 webhook events/day across all databases, well within limits.

### QStash URL Groups (Topics)

One topic per database. Subscribers register their webhook URLs as endpoints.

| Topic Name | Database ID | Subscriber Endpoints |
|---|---|---|
| `notion-contacts` | `1688ebaf-...` | Contacts adapter |
| `notion-clients` | `39b8f7e7-...` | Clients adapter |
| `notion-partners` | `642b44e9-...` | Partners adapter |
| `notion-appearances` | `35d10c83-...` | Appearances adapter |
| `notion-downloads` | `1148ebaf-...` | Downloads adapter |
| `notion-testimonials` | `aa848058-...` | Testimonials adapter |
| `notion-engagements` | `1c68ebaf-...` | Engagements adapter |
| `notion-products` | `1d48ebaf-...` | Products adapter |
| `notion-endorsements` | `3028ebaf-...` | Book Endorsements adapter |
| `notion-sales-pipeline` | `2ed21e43-...` | Pipeline adapter (CST + SET) |
| `notion-partner-pipeline` | `457cfa4c-...` | Pipeline adapter (CST + SET) |
| `notion-activities` | `3178ebaf-...` | Activity webhook adapter |

**Note**: Comms pipeline events arrive via the Appearances database (`35d10c83-...`). The `notion-appearances` topic serves both the Appearances workflow and the Comms pipeline subscribers (CST + SET). This matches the current router behavior.

---

## Phases

### Phase 0: Prerequisites

**Notion DB changes** (manual, in Notion UI):
- Add "Last Activity" (date with time) property to Contacts DB and all three pipeline DBs
- Add properties to Activities DB: Type (select), Summary (rich_text), Sales/Partner/Comms pipeline (two-way relations)
- Convert existing Activities Contact relation to two-way
- Backfill existing activity records with Type = "Email"
- Set up the Notion input form for manual activity logging

**Upstash QStash setup**:
- Create QStash instance in Upstash console (or enable on existing account)
- Obtain `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Add all three to `.env`

**Verify n8n webhook accessibility**:
- Confirm `https://n8n.vennfactory.com/webhook/*` is reachable from the internet (it already is — Notion sends webhooks to it)

---

### Phase 1: Redis Debounce Gate

**Goal**: Stop the ping-pong problem immediately, without changing the fan-out mechanism.

**What changes**: Only the webhook router. No subscriber changes.

**Steps**:

1. **Create `patch-router-debounce.js`** — Modifies the live router to insert a Redis debounce check after "Skip Deleted Events" and before "Load Referenced Page":
   - Add a Code node that builds the Redis REST API URL: `{UPSTASH_URL}/set/debounce:page:{entity.id}/1?EX=10&NX=true`
   - Add an HTTP Request node that calls the Upstash Redis REST API (GET for SET with params)
   - Add an IF node: if Redis returned `null` (duplicate) → respond 200 and stop
   - If Redis returned OK → proceed to "Load Referenced Page" (existing flow continues unchanged)

2. **Test**: Edit a Notion contact, verify only 1 execution fires (instead of 2–3)

3. **Monitor**: Watch execution counts for a day to confirm debounce is working

**Files**:
| File | Action |
|---|---|
| `patch-router-debounce.js` | **Create** |

---

### Phase 2: Adapter Workflows + QStash Wiring

**Goal**: Create the adapter layer that sits between QStash and the existing sub-workflows. Adapters are deployed but not yet receiving traffic — they'll be activated when the router switches to QStash publishing in Phase 3.

**One adapter per database** — fully decoupled. Adding or removing a subscriber never touches other adapters.

**Adapter pattern** (each adapter follows this template):

```
Webhook Trigger (path: /webhook/adapter-{name}, method: POST)
    │
    ▼
Verify QStash Signature (Code node — manual HMAC-SHA256 JWT verification)
    │   - Extract JWT from Upstash-Signature header
    │   - Split into header.payload.signature
    │   - Verify HMAC-SHA256 using QSTASH_CURRENT_SIGNING_KEY (fall back to NEXT key for rotation)
    │   - Validate claims: iss === "Upstash", exp > now, body hash matches SHA-256 of raw body
    │   - n8n Code nodes have access to Node.js built-in crypto module for HMAC + SHA-256
    │
    ▼
Fetch Page from Notion (HTTP Request — GET /pages/{entity.id} with Notion credential)
    │
    ▼
Format Payload (Code node — build { body, record } matching existing shape)
    │
    ▼
Execute Sub-Workflow(s) (one or more Execute Workflow nodes)
```

**Steps**:

1. **Create `lib/adapter-template.js`** — shared helper that generates an adapter workflow given:
   - Adapter name and webhook path
   - Target sub-workflow ID(s)
   - Includes the shared QStash JWT verification Code node (HMAC-SHA256 using `crypto.createHmac` — available in n8n Code node sandbox)
   - Includes the Notion page fetch + payload formatting steps
   - Signing keys read from environment via `$env.QSTASH_CURRENT_SIGNING_KEY` / `$env.QSTASH_NEXT_SIGNING_KEY` (n8n expressions can access env vars)

2. **Create adapter workflow files** (in `workflows/`):

   | Adapter File | Webhook Path | Calls | Needs Full Record? |
   |---|---|---|---|
   | `adapter-contacts.js` | `/webhook/adapter-contacts` | Contacts Workflow (`XfO5Zg1zn6A4vhD6`) | Yes |
   | `adapter-clients.js` | `/webhook/adapter-clients` | Clients Workflow (`GMNBwXAkFWc7XhlG`) | Yes |
   | `adapter-partners.js` | `/webhook/adapter-partners` | Partners Workflow (`G5JpSIFZSBNVM8RR`) | Yes |
   | `adapter-appearances.js` | `/webhook/adapter-appearances` | Appearances (`ceyZMOF8SKTkilhd`) + CST + SET | Yes |
   | `adapter-downloads.js` | `/webhook/adapter-downloads` | Downloads (`oPFK3KGX1tTItJHt`) | Yes |
   | `adapter-testimonials.js` | `/webhook/adapter-testimonials` | Testimonials (`YlSBvDkZLHocJCjU`) | Yes |
   | `adapter-engagements.js` | `/webhook/adapter-engagements` | Engagements (`0VlE1zFPDaz94blF`) | Yes |
   | `adapter-products.js` | `/webhook/adapter-products` | Products (`MFoTZac1zXBHGdc5`) | Yes |
   | `adapter-endorsements.js` | `/webhook/adapter-endorsements` | Book Endorsements (`gmtPuFBhZ56ImCcX`) | Yes |
   | `adapter-sales-pipeline.js` | `/webhook/adapter-sales-pipeline` | CST + SET | Yes (SET needs status + name) |
   | `adapter-partner-pipeline.js` | `/webhook/adapter-partner-pipeline` | CST + SET | Yes |
   | `adapter-activities.js` | `/webhook/adapter-activities` | Activity Webhook (new) | Yes |

3. **Create `workflows/activity-webhook.js`** — the new activity tracking sub-workflow (see Activity Tracking section below)

4. **Build and push all adapters + activity-webhook**:
   ```sh
   node build.js
   node push-workflows.js
   ```

5. **Create `setup-qstash-topics.js`** — script that:
   - Creates all 12 QStash URL Groups via the API
   - Registers each adapter's webhook URL as an endpoint in the appropriate topic
   - Outputs the topic configuration for verification
   - Supports `--dry-run`

6. **Run the setup script** to register all topics and endpoints in QStash

7. **Test each adapter independently**: Use curl to POST a test payload to each adapter's webhook URL, verify it fetches the page and calls the sub-workflow correctly

**Files**:
| File | Action |
|---|---|
| `lib/adapter-template.js` | **Create** — shared adapter workflow generator |
| `workflows/adapter-*.js` (12 files) | **Create** — one per database |
| `workflows/activity-webhook.js` | **Create** — activity tracking sub-workflow |
| `setup-qstash-topics.js` | **Create** — QStash topic + endpoint registration |

---

### Phase 3: Router Cutover to QStash

**Goal**: Replace the router's Switch + Execute Workflow fan-out with a single QStash publish. The debounce gate from Phase 1 stays; the fan-out mechanism changes.

**Steps**:

1. **Create `patch-router-qstash.js`** — Modifies the live router:
   - Remove the "Load Referenced Page" node (adapters now handle this)
   - Remove the "Route By Database" Switch node and all its downstream Execute Workflow nodes
   - Remove all per-database Format/Set nodes
   - After the Redis debounce gate (IF returned OK), add:
     - A Code node that maps `body.data.parent.id` → QStash topic name
     - An HTTP Request node: `POST https://qstash.upstash.io/v2/publish/{topicName}` with headers:
       - `Authorization: Bearer {QSTASH_TOKEN}`
       - `Upstash-Delay: 10s`
       - `Content-Type: application/json`
     - Body: the minimal event payload `{ body }` (no `record` — adapters fetch fresh data)
   - Wire to "Success: Respond to Webhook"

2. **Dry-run first**: `node patch-router-qstash.js --dry-run`

3. **Apply the patch** and immediately test:
   - Edit a Notion contact → verify the adapter fires ~10s later
   - Edit a pipeline deal → verify both CST and SET adapters fire
   - Create a manual activity → verify activity-webhook fires
   - Check execution logs for correct debounce behavior

4. **Activate all adapter workflows** (they were pushed inactive in Phase 2)

5. **Monitor for 24 hours**: Compare execution counts with pre-migration baseline

**Files**:
| File | Action |
|---|---|
| `patch-router-qstash.js` | **Create** — router cutover script |

---

### Phase 4: Adapt Email Activity Log

**Goal**: Update `email-activity-log.js` to work with the new Activities DB schema.

**Steps**:

1. Add `Type: { select: { name: 'Email' } }` to the activity creation properties in `MATCH_DEDUP_CODE`
2. Remove the "Last Activity" update path (nodes `buildLastContactedPatch` + `updateLastContacted` and connections) — the activity-webhook adapter now handles this centrally via the QStash-delivered webhook
3. Build and push:
   ```sh
   node build.js --workflow email-activity-log
   node push-workflows.js --workflow email-activity-log
   ```

**Files**:
| File | Action |
|---|---|
| `workflows/email-activity-log.js` | **Modify** |

---

### Phase 5: Cleanup

1. **Delete old patch scripts** that are no longer needed:
   - `patch-router.js` (pipeline wiring — now handled by adapters)
   - `patch-router-debounce.js` (absorbed into `patch-router-qstash.js`)

2. **Archive the router backup**: The pre-migration `server/notion-webhook-router-live.json` serves as rollback reference

3. **Update LESSONS.md**: Mark the debounce plan as implemented, document the QStash architecture

4. **Update CLAUDE.md**: Document the new adapter pattern and QStash topic setup for future workflow additions

---

## Activity Tracking Sub-Workflow Detail

`workflows/activity-webhook.js` — called by `adapter-activities.js` via Execute Workflow.

```
Execute Workflow Trigger
    │
    ▼
Parse & Build Patches (Code)
    │   - read record.property_date, property_contact, property_sales_pipeline, etc.
    │   - validate: must have a date and at least one contact
    │   - build PATCH bodies using activity's Date value (not today)
    │   - output contactPatches + dealPatches arrays
    │
    ├──▶ Expand Contact Patches (Code) → Update Contact Last Activity (HTTP PATCH)
    │
    └──▶ Expand Deal Patches (Code) → Has Deals? (IF) → Update Deal Last Activity (HTTP PATCH)
```

- Uses the activity's Date value (not `new Date()`), since users may log past interactions
- PATCH body: `{ properties: { "Last Activity": { date: { start: "<datetime>" } } } }`
- Both HTTP PATCH nodes: batched (1/334ms), retryOnFail, continueOnFail
- `callerPolicy: 'workflowsFromSameOwner'`, error workflow `EZTb8m4htw60nP0b`

---

## Activities DB Schema

**Existing properties** (kept for backward compat with email records):
- Name (title), Contact (two-way relation), Direction (select), Date (date), Subject (rich_text), Email Address (email), Message ID (rich_text), Preview (rich_text)

**New properties**:
| Property | Type | Values/Target |
|---|---|---|
| Type | select | Email, Phone, Text, Signal, Slack, WhatsApp, Meeting, Other |
| Summary | rich_text | Short description (detailed notes go in page body) |
| Sales pipeline | two-way relation | → Sales DB |
| Partner pipeline | two-way relation | → Partner DB |
| Comms pipeline | two-way relation | → Comms DB |

---

## Rollback Plan

Each phase is independently reversible:

- **Phase 1**: Remove debounce nodes from router (restore from backup JSON)
- **Phase 2**: Adapter workflows are inactive until Phase 3 — no impact if abandoned
- **Phase 3**: Re-apply old router from backup, deactivate adapters, reactivate old sub-workflows
- **Phase 4**: Revert email-activity-log.js from git

---

## File Summary

| File | Phase | Action |
|---|---|---|
| `patch-router-debounce.js` | 1 | **Create** |
| `lib/adapter-template.js` | 2 | **Create** |
| `workflows/adapter-*.js` (12 files) | 2 | **Create** |
| `workflows/activity-webhook.js` | 2 | **Create** |
| `setup-qstash-topics.js` | 2 | **Create** |
| `patch-router-qstash.js` | 3 | **Create** |
| `workflows/email-activity-log.js` | 4 | **Modify** |
| `LESSONS.md` | 5 | **Update** |
| `CLAUDE.md` | 5 | **Update** |
