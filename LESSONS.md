# Lessons Learned — Project-Specific

Project-specific knowledge for this n8n workflows codebase. General n8n workflow lessons have been extracted to [`GENERAL-LESSONS.md`](./GENERAL-LESSONS.md).

---

## n8n API

### Workflow activation/deactivation
- `POST /api/v1/workflows/{id}/activate` — activates a workflow (registers triggers/webhooks)
- `POST /api/v1/workflows/{id}/deactivate` — deactivates a workflow
- Both return the full workflow object with the updated `active` field
- The `push-workflows.js` PUT endpoint does NOT change activation state — use these dedicated endpoints
- Scripts: `activate-workflows.js` and `deactivate-workflows.js` accept `--workflow <name>` or activate/deactivate all adapter workflows by default

---

## n8n Canvas Node Positioning

### Reference: Notion Webhook Router layout
```
y=160  ·Sticky Note (128,160)
y=200  ····························FetchDB→ExecData (688–912,200)     [audit branch]
y=400  Webhook→Maint?→Restore→Sig→Trust→Skip→IsDB?→Build→Redis→Restore→Routable?→Publish  [spine]
       (-1104 ··········································· 464 ··· 688 ··· 912 ··· 1360 ··· 1584)
y=680  ·····························································Success: Respond (1808,680)
y=880  ·····························································Error: Respond (1808,880)
```
IF output wiring convention: output 0 (true) stays on or above the spine; output 1 (false) drops below.

---

## Server-Specific Credential Configuration

### Anthropic API uses `httpHeaderAuth`, not `anthropicApi`
- The Anthropic API key credential on our server is registered as a **generic HTTP Header Auth** credential, not the n8n built-in `anthropicApi` type
- Use `authentication: 'genericCredentialType'` + `genericAuthType: 'httpHeaderAuth'` (NOT `authentication: 'predefinedCredentialType'` + `nodeCredentialType: 'anthropicApi'`)
- Credential object key must be `httpHeaderAuth`, not `anthropicApi`
- Reference: `stale-pipeline-alerts.js` lines 84-86, 577-578

### Anthropic API key stored as Header Auth credential
The Anthropic API key on this server is stored as an `httpHeaderAuth` credential (not the native `anthropicApi` type). This means:
- `lmChatAnthropic` and `chainLlm` nodes **cannot** use it (they require `anthropicApi` credential type)
- HTTP Request nodes must use `authentication: 'genericCredentialType'` with `genericAuthType: 'httpHeaderAuth'` (not `predefinedCredentialType` with `nodeCredentialType: 'anthropicApi'`)
- The credential reference key is `httpHeaderAuth` (not `anthropicApi`):
  ```js
  credentials: { httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' } }
  ```
- The `anthropic-version` header must still be sent separately via `headerParameters`

---

## Project Conventions

### Always ask permission before pushing workflows to the server
Never run `push-workflows.js` (or otherwise upload a workflow to the n8n server) without explicit user confirmation first. Building to `output/` is safe, but pushing to the live server can overwrite running workflows and should always be a deliberate, user-approved action.

---

## Pipeline Priority field values and normalization
All three pipelines (Sales, Partner, Comms) have a Priority field, but the Sales pipeline uses different values from the other two.

**Partner & Comms pipelines** use a standard scale: `High`, `Medium`, `Low` (some entries are blank).

**Sales pipeline** uses lifecycle categories instead: `Hot Prospects`, `Active Projects`, `Past Projects`, `Lost Projects`. These map to the standard scale as follows:

| Sales Priority value | Normalized priority |
|----------------------|---------------------|
| Hot Prospects        | High                |
| Active Projects      | Medium              |
| Past Projects        | Low                 |
| Lost Projects        | Low                 |

`Lost Projects` is historical and redundant with the Status field (which already marks these as `Lost/rejected`). Any automation that reads Priority across pipelines should normalize Sales values to High/Medium/Low using this mapping.

---

## Future Work

### Mailchimp ↔ Notion linkage via NOTIONID merge field

**Status**: Implemented (March 2026). The guard lives in `workflows/create-or-update-mailchimp-record.js` (replaces `server/create-or-update-mailchimp-record.json`). The `page.deleted` branch is not yet implemented — deleted events are still filtered by the router.

**Problem**: The Notion Webhook Router (`6kSboH0MtIOedeja`) fires for every Contacts DB change, including when the Merge Duplicate Contacts workflow archives source records. Since source and destination share the same email, the archive event can overwrite Mailchimp with stale data from the source record.

**Solution**: A `NOTIONID` custom text merge field in the Mailchimp audience stores the Notion page ID of the canonical contact. The guard in the Mailchimp sub-workflow checks this before allowing updates.

**Guard logic (event type × NOTIONID)**:

| Event type | `NOTIONID` in Mailchimp | Action |
|---|---|---|
| `page.properties_updated` | Matches incoming page ID | Update Mailchimp record |
| `page.properties_updated` | Blank / missing | Update Mailchimp **and write** incoming page ID into `NOTIONID` (claim) |
| `page.properties_updated` | Set but doesn't match | **Skip** (stale/duplicate source) |
| `page.deleted` | Matches incoming page ID | **Archive** the Mailchimp member (canonical contact was deleted) — *not yet implemented* |
| `page.deleted` | Doesn't match or blank | **Skip** (duplicate was deleted, not the canonical) — *not yet implemented* |

**Implementation details**:
- The guard is a Code node (`NOTIONID Guard`) placed between the Mailchimp lookup and the Update/Create Switch
- A `should_claim` flag triggers an update even when no other fields changed, ensuring NOTIONID gets written on first contact
- Callers without a `notion_page_id` bypass the guard entirely
- The workflow accepts `id` or `notion_page_id` — the Enforce Required Format node normalizes to `notion_page_id`
- Both Update and Create paths write NOTIONID into Mailchimp merge fields

**Pre-requisite**: The `NOTIONID` text merge field must exist in Mailchimp audience `77d135987f` before deploying. Create via UI or API: `POST /lists/77d135987f/merge-fields` with `{ "name": "Notion ID", "tag": "NOTIONID", "type": "text" }`

**Edge cases**:
- *New Mailchimp member from signup form (no Notion record yet)*: NOTIONID stays blank until a Notion contact with the same email triggers a webhook, which then claims it.
- *Notion record deleted and recreated*: New page ID won't match. Guard could check if the page referenced by NOTIONID is archived/deleted (GET `/pages/{id}`, check `archived: true`); if so, allow the new page to re-claim. Not yet implemented.
- *Two Notion duplicates fire webhooks before merge runs*: First one claims. Second is blocked. Running the merge workflow resolves the underlying duplicate.

**Mailchimp Profile URL write-back**: When the NOTIONID guard claims a subscriber (blank NOTIONID), the Mailchimp sub-workflow writes the Mailchimp admin profile URL back to the Notion contact's "Mailchimp Profile" url property. The URL is also written during the initial Notion upsert when a Mailchimp webhook fires — the Mailchimp Audience Hook extracts `web_id` from the payload and passes `mailchimp_profile` to the upsert sub-workflow. The DC (`MAILCHIMP_DC` in `.env`) is used to construct the URL.

**Affected workflows**:
- `Create or Update Mailchimp Record` — `workflows/create-or-update-mailchimp-record.js` (contains the guard + write-back)
- `Contact Updates from Notion` — `workflows/contact-updates-from-notion.js` (passes `notion_page_id`)
- `Mailchimp Audience Hook` — `workflows/mailchimp-audience-hook.js` (passes `mailchimp_profile` URL to upsert)
- `Notion Master Contact Upsert` — `workflows/upsert-contact.js` (writes `mailchimp_profile` to Notion)
- `Adapter: Contacts` — `workflows/adapter-contacts.js` (already passes `id` in field mappings)

### `page.deleted` events in the Notion Webhook Router — broader implications

The webhook subscription receives all page events including `page.deleted`. The router currently does not filter on event type, so `page.deleted` events flow through the same paths as `page.properties_updated`. This affects **all** routed databases, not just Contacts:

| Database | Sub-workflow | Theoretical `page.deleted` behavior |
|---|---|---|
| Contacts | Contact Updates from Notion → Mailchimp | Should archive/remove the linked Mailchimp member |
| Appearances | Execute Appearances Workflow | Should remove the matching entry from Webflow |
| Clients, Partners, Testimonials, etc. | Their respective sub-workflows | Would need equivalent cleanup in downstream systems |

**Current stance**: Record deletion is generally poor practice — marking a record as inactive is preferred. No deletion-propagation logic exists in any of the sub-workflows today. The router silently processes `page.deleted` events through the same update path, which may cause errors or no-ops depending on what the sub-workflow tries to do with a deleted page's data.

**Implemented (March 2026)**: A "Skip Deleted Events" filter node was added to the router (after "Trusted Payload?") that drops events where `body.type` ends with `.deleted`. This covers both `page.deleted` and `database.deleted`. A sticky note on the canvas documents the rationale. Manually tested and confirmed working.

**Long-term**: If deletion propagation is ever needed, implement it per-database with the NOTIONID-style linkage pattern (for Contacts → Mailchimp) or equivalent ID-based guards for other systems (e.g., Webflow item ID for Appearances). Each sub-workflow would need a dedicated `page.deleted` branch that performs the correct cleanup action in the downstream system.

### Notion Webhook Router: debounce to prevent ping-pong loops

**Problem**: Notion fires multiple webhook events for a single user action (e.g., `page.created` + `page.properties_updated` within ~1 second). Each event triggers an independent n8n execution, causing race conditions in downstream writes (Mailchimp, Notion upsert) and amplifying bidirectional sync bounce-backs. A single contact edit can produce 19 executions across 5 workflows.

**Root causes identified** (from execution trace of `bredetrollsaas@outlook.com`, March 2026):
1. **Race condition**: Two near-simultaneous Notion events both fetched stale Mailchimp data before either write completed, causing duplicate writes and duplicate Mailchimp `profile` webhooks
2. **Data mismatch bounce**: Notion had `Email Marketing: null` while Mailchimp had `status: subscribed`. The Mailchimp→Notion sync correctly wrote `Subscribed` back, but that triggered another Notion webhook cycle
3. **Notion Upsert includes all non-null fields in PATCH**, not just changed ones (cosmetic — doesn't cause the loop but adds noise to webhook events)

**Proposed debounce + fan-out approach**: Combine **Upstash Redis** (dedup gate) with **QStash** (delayed delivery + pub/sub fan-out):

1. After webhook validation, extract `entity.id` (page_id)
2. HTTP Request to Upstash Redis: `SET debounce:page:{page_id} 1 EX 10 NX` (set-if-not-exists, 10-second TTL)
3. If SET returned null → duplicate within 10 seconds → respond 200 and stop
4. If SET returned OK → first event for this page → publish to QStash URL Group (topic) with a **10-second delay**
5. After the delay, QStash delivers the message to all subscriber webhook endpoints
6. Each subscriber fetches the **current** page state from Notion at execution time (not the stale payload from 10 seconds ago)

**Why the delay matters**: The Redis gate passes the first event in a burst and drops the rest. The 10-second QStash delay lets the burst fully settle before any subscriber acts. Since subscribers read fresh Notion data on delivery, it doesn't matter that the triggering event was the first rather than the last.

**Why QStash for fan-out**: Currently the router uses a Switch node + Execute Workflow nodes to dispatch to sub-workflows. Adding a new subscriber requires patching the router. With QStash URL Groups, each sub-workflow registers its own webhook endpoint as a topic subscriber — the router just publishes to the topic. Adding/removing subscribers requires no router changes.

Both services are available via Upstash (credentials already in `.env`). Redis is the dedup gate (one SET call per event), QStash handles delayed delivery and fan-out. No polling anywhere.

**Status**: Not yet implemented. Planned as part of the activity tracking + router refactor work.

---

### Notion address components mapping
Notion stores address components in separate fields (Street Address, Address Line 2, City, State, Postal Code, Country) — map each one to the corresponding Mailchimp ADDRESS sub-field.

---

### Known Anthropic model IDs (project reference)
**Current model IDs** (from Anthropic docs, Feb 2026):
| Model | API ID | Alias |
|-------|--------|-------|
| Sonnet 4.6 | `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` |
| Opus 4.6 | `claude-opus-4-6` | `claude-opus-4-6` |
| Sonnet 4.5 | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` |

Use the alias (no date suffix) for latest models; use dated IDs to pin a specific snapshot. **Note**: Claude 3.x models (e.g., `claude-3-5-haiku-20241022`) have been deprecated and return 404 "model not found" errors.
