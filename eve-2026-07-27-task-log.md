# Eve Maler / Venn Factory — Automation Task Log

**Source:** requirements from Fulcrum session 2026-07-27 (`eve-automation-requirements-2026-07-27.md`)
**Planning + grounding:** 2026-07-27 working session (decisions locked, schemas probed live)
**Purpose:** Relationship-log entries for the Venn Factory automation work — each task with the decisions made and **what Eli specifically needs to do**. Per Eli's meta-request on the call.

---

## Decisions locked (2026-07-27)

| Topic | Decision |
|---|---|
| Where contract data is written | **Both DBs from one intake** — a single extraction writes the NDA record (unchanged) *and* a Client-engagement row |
| Engagement rows | **One row per agreement** (per-contract-file, like the NDA DB) |
| Invoicing (item 3) | **Notion first, QuickBooks later** — the Notion financial record is the hard requirement; QB is a later phase |
| Invoice approval gate | Deferred — **decide at the QB phase** |
| Backlog of hand-entered financials | **Reconcile once, then automate** — match existing rows, human-confirm, stamp a durable key; hand-entered numbers are authoritative and never overwritten |
| `Client db` link | Reuse the existing **"Clients"** DB (`39b8f7e7`) — same one the NDA intake already resolves |
| DCAM task | **Parked** out of this plan pending scope |
| Automation catalog (item 5) scope | **Deferred** — revisit closer to the mid-August site redo |
| Site-rebuild spec | **Not needed yet** — surfaces when the redo starts |

---

## Task entries

### 1. Expand contract-intake extraction — HIGH
**What it is:** Extend the existing NDA intake (`ingest-nda-contracts.js`) to extract, beyond confidentiality: relationship-level renewal (distinct from the confidentiality `auto_renew` already captured), termination-for-convenience notice window, invoicing schedule / payment terms / amounts, deliverables, contractual POC, and non-standard obligations. Unknowns surface as flags.
**Status: DONE & LIVE (2026-07-27).** Expanded extraction (descriptive + structured commercial fields mapping to the financials columns) verified across dry runs over the full backlog; `open_questions` surfaces unknowns for review. Live.
**What Eli needs to do:** Build item 1 in dry-run and review the extracted new fields against real contracts. This also produces the client + effective-date + amount that the item-2 reconciliation needs, so it comes first.
**Depends on:** Nothing. Quality improves as Eve rationalizes contract folders (item 8).

### 2. Auto-populate Client engagement financials — REALLY CRITICAL
**What it is:** From the same intake, create one row per contract in **Client engagement financials** (`1c68ebaf`), linked to the client and (ideally) the NDA record. Extracted commercial terms map onto fields that already exist (payment terms, cycle, amounts, dates); POC / obligations / renewal / notice / deliverables need **new fields**.
**Status:** Blocked on two things below. Design fully specified.
**Decisions:** Both-DBs-one-intake · one row per agreement · reconcile-once-then-automate · hand-entered financials authoritative (fill blanks + add new fields only, never overwrite) · every row carries a durable **Contract-file key** so future runs dedup exactly.
**Status: DONE & LIVE (2026-07-27).** 8 new fields added to Client engagement financials via API (Contract file, POC, Non-standard obligations, Relationship renewal, Renewal terms, Termination notice, Deliverables, Invoicing schedule). The intake now writes a financials row per contract alongside the NDA record, gated by fee_type (retainer→cycle, one_time/per_event→due-at-start, hourly/contingent/none→skip), linked to Client db, with fee prose + open-questions in the page body. Live.

### 2a. Forecast Engine early-exit gate — DISSOLVED (decision 2026-07-27)
**Outcome: not built.** Investigated deeply — the naive `updated_properties` gate is unsafe because the router's 10s debounce can hide a relevant edit behind an irrelevant one; a value-diff snapshot gate was the robust alternative but has a bootstrap problem. **Decision: no code gate.** The reconciliation batch is protected by **maintenance mode** (router drops engagement events → no recalc cascade), and steady-state stray edits each fire one harmless idempotent recalc. Investigation still paid off: confirmed `Client db` → the "Clients" DB `39b8f7e7`, and the exact forecast-relevant field set.

### 2b. Reconcile existing hand-entered financials rows — DONE (2026-07-27)
**Outcome: complete.** Matched contracts to existing rows (client + effective date + amount, 1:1 assignment), Eli confirmed the fuzzy ones. **23 rows stamped** with Contract-file keys + non-financial fills, under maintenance mode. Zero genuinely-new rows — every contract mapped to an existing hand-entered row (Eli's domain knowledge caught 3 my matcher missed: KuppingerCole="KC SB engagement", Relock 03-06="Relock advisory '26-'28", Commvault="Commvault podcast"). Two authorized financial corrections: Relock $4000→$3600, KuppingerCole term end→2027-07-31. IDENTOS 09-11 = amendment of the 2025 "IDENTOS advisory" row (values already reflect the amendment; no write). Financials write verified safe (dedup 24→4→0) and now live.

### 3. Invoicing automation
**What it is:** Notion record of invoices/engagement financials (hard requirement) enabling proactive renewal/POC lookups; QuickBooks as the direct driver later.
**Status:** Satisfied for Notion the moment item 2 populates Engagements. QB is a separate later phase.
**Decisions:** Notion first, QB later · approval gate decided at QB phase.
**What Eli needs to do:** Nothing until item 2 is solid. Then scope the QB phase: which QB entities we drive, Notion-vs-QB source of truth, and the approval design. Eve is comfortable granting the QB connection.
**Depends on:** Item 2.

### 4. Daily morning readiness routine
**What it is:** Scheduled morning run — hygiene on account notes + sales pipeline (currently done by hand via her sales-prospect-setup skill), light-web-research background section, upcoming-meeting prep, account-status summary. Framed as a step toward a "company OS."
**Status:** Future / larger scope.
**What Eli needs to do:** Defer. Scope separately later; it leans on her sales-prospect-setup skill's behavior.
**Depends on:** Nothing hard; sequenced after the contract-to-cash chain.

### 5. Catalog Notion automations before the site redo
**What it is:** Catalog what the existing automations do and where they're brittle — prerequisite for the **mid-August online-presence redo**. (Reframed from the old "centralized automation architecture" task.)
**Status:** Partially scaffolded — `workflow-catalog.md` exists but is a server-vs-local comparison, not a does-what / brittle-points catalog. `ROUTER-REFACTOR-PLAN.md` is the reframed architecture context. Scope deferred per the call.
**What Eli needs to do:** Decide catalog scope closer to mid-August (n8n-only vs n8n + Notion-native vs web-content-only). Note: today's planning already found a live brittle point to include — the Forecast Engine's `Client db` handling (see findings).
**Depends on:** Timing driver is Eve producing the content design for the redo.

### 6. CRM Activities usability
**What it is:** Capture is **done** (activities are logged via activity-webhook / email-activity-log). New task: the **Activities view is not usable** — rework how activities are presented/organized.
**Status:** Independent; mostly Notion view/schema design, possibly a small supporting automation for a grouping/display field.
**What Eli needs to do:** Scope the view rework with Eve (what "usable" means to her — grouping, rollups, filters). Low code.
**Depends on:** Nothing.

### 7. NDA database timeline view — LOW (Eve idea)
**What it is:** Possible timeline view off the NDA DB that generates tasks when dates come due. Not committed. Overlaps item 6 (both derive a useful view + tasks from a DB).
**Status:** Parked. Eve intends to retest NDA data before relying on it.
**What Eli needs to do:** Park; revisit alongside item 6 if pursued.
**Depends on:** Eve's NDA-data retest.

### 8. Contract file rationalization (Eve's task; possible RFE for us)
**What it is:** Eve surfaces all contracts into each account's top-level Contracts folder so the intake finds them. Contracts also live in **VF Comms** and **VF Events** folders. Possible RFE: intake to eventually scan more locations / assist a migration.
**Status:** Eve's action. RFE noted.
**What Eli needs to do:** Design the intake's folder-scan as a **configurable list of locations** now, so handling VF Comms / VF Events later is cheap. Await Eve's discoveries.
**Depends on:** Eve.

### 9. Task-list housekeeping (from the call)
- **DCAM records** — parked pending scope (referent was cut off; confirm with Eve).
- **Replace Mandrill / MDID site link** — dropped; superseded by the larger VF site rebuild.
- **Centralized automation architecture** — duplicate; the live version is the item-5 catalog.
- **Invoice automation (old entry)** — done as written; superseded by item 3.
- **This log** — the meta-request itself: all tasks captured here with what Eli needs to do.
**What Eli needs to do:** Place these entries in the Eve relationship log; confirm the DCAM referent with Eve when convenient.

---

## Technical findings (captured live during planning — grounding for the build)

### Forecast recalc chain
`edit financials row (1c68ebaf)` → Notion router (`6kSboH0MtIOedeja`) → `notion-engagements` → Adapter: Engagements (`dwRKnvedcxqhdmLj`) → **Forecast Engine `0VlE1zFPDaz94blF`**. The engine does a **full recompute** (archive-all + recreate-all) into a separate projections DB (`1c98ebaf`) — it does *not* write back to financials, so no feedback loop. But every single row edit triggers a complete rebuild.

### The 11 forecast-relevant fields + `updated_properties` identifiers
Derived from what the Forecast Engine's code actually consumes. The early-exit gate recalculates only when a changed property is in this set:

| Field | Identifier |
|---|---|
| Engagement type | `%3BVNU` |
| Cycle payment | `%3CVrq` |
| Currency | `%3DWZk` |
| Due at end | `%3FL%5D%7C` |
| Cycle count | `A%5DJ%7D` |
| Due at start | `I%5B%7BD` |
| Sales pipeline | `%5Bcg%7D` |
| Engagement start&end | `m%3B%5BF` |
| Payment terms | `u%5EVj` |
| Cycle length | `zdin` |
| Client db | `YjRd` |

Format confirmed: `updated_properties` emits URL-encoded raw property IDs (151/154 workspace-wide; the 3 exceptions are a semantic Status property the financials DB doesn't have). **NOT relevant** (safe to skip): Notes, ICP type (rollup), the title, Effective date, and every new field we add (Contract file, POC, obligations, renewal, notice, deliverables) — so all reconciliation edits early-exit; only a fill-blank on a relevant field recalcs.

### `Client db` → the "Clients" database
`Client db` (id `YjRd`) relates to **"Clients"** (`39b8f7e7`) — the *same* DB the NDA intake already reads/writes via `Client record`. So item 2's client link reuses machinery that already works; no second Clients DB, no new access grant. (The relation was hidden from the DB schema API response but visible at the page level — a Notion relation quirk, not a permissions gap. Confirmed by following a real row → linked page "BalkanID" → parent DB "Clients".) Note: this is distinct from **WebDB Clients** (the logo-carousel source named in the requirements).

### Forecast keys on `Engagement start&end`, not `Effective date`
The engine's payment schedule reads `Engagement start&end.start/.end`, `Cycle count/length`, `Payment terms`, `Cycle payment`, `Due at start/end`, `Currency`, `Engagement type`, `Client db`, `Sales pipeline`. `Effective date` is **not** consumed. **Confirm with Eli/Eve this is intentional** — the contract side treats effective date as the anchor, so there's a seam worth acknowledging.

---

## Open questions still outstanding
1. Who adds the new financials-DB fields — Eve or us? (recommend Eve, with our field spec)
2. Is the forecast intentionally keyed on `Engagement start&end` rather than `Effective date`?
3. DCAM task referent (confirm with Eve).
4. Catalog scope (item 5) — settle closer to mid-August.
5. QB phase specifics — deferred to that phase.
