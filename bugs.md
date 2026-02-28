# Bugs & Issues

QA audit of all workflow definitions, build/deploy scripts, and server state.
Last updated: 2026-02-27.

---

## P1 — Likely issues (should verify/fix)

### ~~1. No webhook response node in MDI Subscriber Hook~~ FIXED
**File:** `workflows/mdi-subscriber-hook.js`
**Issue:** The workflow had no Respond to Webhook node. Webflow received no HTTP response and could retry or timeout.
**Fix:** Added Respond to Webhook node ("Respond OK") after the Upsert Contact node, with `responseMode: 'responseNode'` on the Webhook trigger. The 200 is only sent after a successful upsert — if the upsert fails, n8n returns a 500 so Webflow can retry.

### ~~2. Empty email passes through to upsert~~ FIXED
**File:** `workflows/mdi-subscriber-hook.js`
**Issue:** Empty emails made unnecessary Execute Workflow calls to the upsert sub-workflow.
**Fix:** Added "Has Email?" Filter node between Map to Contact and Upsert Contact. Records with empty email are dropped before the sub-workflow call.

### ~~3. HMAC signature validation uses re-serialized body~~ IGNORED
**File:** `workflows/mdi-subscriber-hook.js` (Validate Signature node)
**Issue:** `JSON.stringify` re-serializes the body for HMAC comparison; if n8n changes key ordering on a future upgrade, signature validation could break silently. Pre-existing issue, works today, and n8n doesn't expose raw request bytes — nothing actionable.

---

## P2 — Code quality / robustness

### 4. Missing explicit `matchType` on Notion lookup filter
**File:** `workflows/upsert-contact.js` line 148
**Issue:** The Notion v2.2 `getAll` manual filter omits the top-level `matchType` parameter. n8n defaults to `"anyFilter"` (confirmed in the UI), so behavior is correct today. Adding it explicitly would guard against a future default change.
**Fix:** Add `matchType: 'anyFilter'` to the lookup node's parameters object.

### 5. Redundant `alwaysOutputData` assignment
**File:** `workflows/upsert-contact.js` lines 165-166
**Issue:** Both `lookup.settings = { alwaysOutputData: true }` and `lookup.alwaysOutputData = true` are set. The `settings` key is stripped by `push-workflows.js` for API pushes; only the top-level property matters. The `settings` line is harmless for JSON import but redundant.
**Fix:** Remove line 165 (`lookup.settings = ...`).

### ~~6. `.env` parsing duplicated across 3 scripts~~ FIXED
**Files:** `build.js`, `push-workflows.js`, `pull-workflows.js`
**Issue:** Each script had its own `.env` parser with the same regex.
**Fix:** Extracted to `lib/load-env.js` with `required` and `setProcessEnv` options. All three scripts now import the shared module.

### 7. Non-deterministic node IDs
**Files:** All workflow definitions
**Issue:** `crypto.randomUUID()` generates new IDs on every build, so `output/*.json` changes even with no logic changes. Makes diffing output harder and could trigger unnecessary API updates on push.
**Fix (optional):** Use deterministic IDs based on a hash of node name + workflow name.

### 8. No CLI argument validation
**Files:** `build.js`, `push-workflows.js`, `pull-workflows.js`
**Issue:** `node build.js --workflow` (without a name) silently tries to build `undefined.js`. Same pattern in push/pull scripts.
**Fix:** Validate that `args[singleIdx + 1]` exists and exit with a helpful error.

### 9. Old upsert workflow copy on server
**ID:** `3erFj6n1onXupe5n`
**Issue:** An archived, broken copy of "Notion Master Contact Upsert" exists on the server. It has a wrong database ID format (no `__rl` wrapper), uses the buggy `defineBelow` trigger mode, and lacks the tag merge fix. No active workflows reference it, but having two workflows with the same name is confusing.
**Fix:** Delete from server.

---

## P2.5 — Error handling gap

### 10. No error handling in locally-defined workflows
**Files:** `workflows/upsert-contact.js`, `workflows/mdi-subscriber-hook.js`
**Issue:** Neither workflow has any error handling configured. The server has an established pattern used by most production workflows:
- **Workflow-level:** `settings.errorWorkflow` pointing to the community error handler (`EZTb8m4htw60nP0b`), which sends email alerts on failure.
- **Node-level:** `onError: "continueErrorOutput"` on nodes that may fail (e.g., HTTP requests, sub-workflow calls), allowing downstream error branches.

Server workflows using the error handler include: Contacts Management, Clients Management, Testimonials Management, Book Endorsements Management, Forecast Engine, Notion Webhook Router, and others. Our two locally-defined workflows have neither pattern.

**Impact:**
- **upsert-contact.js:** If a Notion API call fails (rate limit, network error, bad data), the sub-workflow fails silently. The calling workflow gets no error info — just a failed execution.
- **mdi-subscriber-hook.js:** If the upsert sub-workflow fails, the webhook execution fails with no alert. No one knows it broke until they notice missing contacts.

**Fix:**
1. Add `settings.errorWorkflow = 'EZTb8m4htw60nP0b'` to both workflows via `createWorkflow()` settings parameter.
2. Add `onError: 'continueErrorOutput'` on the HTTP Request nodes (Update/Create Contact) in the upsert sub-workflow, and on the Execute Workflow node in MDI Subscriber Hook, so failures don't crash the entire flow.

### 13. Active server workflows missing error workflow
**Workflows affected:**
- **Lead Created** (`p5mNy0BOGjRXDejp`) — contact ingestion webhook
- **MDI Subscriber Hook** (`FOwgPbWEPsHxf3sm`) — Webflow form → Notion contacts
- **Order Created** (`3jZHf7DPGSvf4vYp`) — Thinkific order webhook → Mailchimp
- **Product Created** (`H1Rey91MfRuPMBqk`) — Thinkific → Webflow + Mailchimp sync
- **Product Updated** (`qR1HO77iv8DIf93t`) — Thinkific → Webflow + Mailchimp sync
- **Product Deleted** (`bYjxeEyFzHXv9cUt`) — Thinkific → Webflow + Mailchimp sync
- **Empire Flippers** (`NS21WAjZD28C7Qky`) — daily deal analysis (personal, lower priority)

**Issue:** These 7 active workflows have no `settings.errorWorkflow` configured. If any node fails, the execution errors silently with no alert. The server's Error Handler (`EZTb8m4htw60nP0b`) sends Pushover + email notifications on failure, but only workflows that reference it benefit.

**Impact:** Failures in webhook-triggered workflows (Lead Created, MDI Subscriber Hook, Product/Order hooks) go unnoticed until someone spots missing data in Notion, Webflow, or Mailchimp.

**Fix:** Add `settings.errorWorkflow: 'EZTb8m4htw60nP0b'` to each. For workflows with local `.js` files (MDI Subscriber Hook), add it to the `createWorkflow()` settings and push. For server-only workflows, either recreate as local `.js` files or patch via the n8n API directly.

---

## P3 — Nice to have

### 11. Push/pull scripts don't handle active state
`push-workflows.js` strips `active` from the API body (the n8n PUT/POST endpoints reject it), so pushed workflows always land as inactive regardless of source. There's no `--activate` flag or follow-up API call to set active state. `pull-workflows.js` does preserve `active` in downloaded JSON, but there's no round-trip: a pull → edit → push cycle will deactivate a previously active workflow. For webhook-based workflows this silently breaks inbound traffic until manually re-activated in the n8n UI.

### 12. `build.js` silently skips invalid workflows
If a workflow file has no default export or no `name`, it's skipped with a console warning but the build exits 0. This could mask real problems in CI.
