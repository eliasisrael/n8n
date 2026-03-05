# CRM Enhancement Options for Notion + n8n

## Current State

Our Notion workspace already functions as a lightweight CRM. We have a master contacts database with standardized fields, automated ingest from three sources (Mailchimp, Webflow, Substack), outbound sync via webhook routing, and duplicate detection/merging with full relational consistency across six linked databases (Sales Pipeline, Comms Pipeline, Partner Pipeline, Client DB, Papers, Book Endorsements).

The automations below build on this foundation to close the gaps between what we have and what a purpose-built CRM provides — without adding new paid services. Everything listed runs on infrastructure we already pay for (n8n, Notion, Office 365, Mailchimp, Dropbox).

---

## Option 1: Mailchimp Sync Guard (NOTIONID)

**What it does:** Adds a unique identifier linking each Mailchimp subscriber to their canonical Notion contact record. When the merge-duplicate workflow archives a duplicate contact, the resulting Notion webhook event currently flows through the router and can overwrite Mailchimp with stale data from the archived record. This guard prevents that by checking whether the incoming Notion page ID matches the one Mailchimp has on file.

**Why it matters:** This is a data integrity fix, not a feature. Without it, every duplicate merge risks corrupting Mailchimp subscriber data. The more contacts we merge, the higher the chance of a bad overwrite. The design is already documented in detail — it just needs to be built.

**Expected benefit:** Eliminates stale-data overwrites in Mailchimp. Makes the merge-duplicate workflow safe to run without manually pausing the webhook router.

**Cost:** None. Uses existing Mailchimp merge fields and Notion webhook infrastructure.

**Effort:** Moderate. Touches three existing workflows (Webhook Router, Contact Updates from Notion, Create or Update Mailchimp Record).

---

## Option 2: Stale Pipeline Alerts

**What it does:** A scheduled workflow (e.g., weekly) scans the Sales, Comms, and Partner pipeline databases for records that haven't been updated within a configurable window (e.g., 14 days). It compiles a summary of stale deals — contact name, pipeline stage, days since last activity — and sends it as an email via Office 365.

**Why it matters:** Deals go cold when nobody's watching. Most CRMs solve this with dashboards and reminders, but the underlying mechanic is simple: flag records that haven't moved. This is one of the highest-value automations relative to its complexity.

**Expected benefit:** Prevents deals from silently dying in the pipeline. Creates a regular forcing function to review and act on open opportunities.

**Cost:** None. Uses existing Notion API access and Office 365 email (Microsoft Outlook node in n8n).

**Effort:** Low. Single new workflow — query each pipeline DB, filter by last-edited date, format email, send.

---

## Option 3: Email Activity Logging

**What it does:** Periodically polls Office 365 (via Microsoft Graph API) for sent and received emails, matches sender/recipient addresses against known contacts in Notion, and logs each match as a record in a new "Activities" database. Each activity record links to the contact via a relation property and captures the date, subject line, and direction (sent/received).

**Why it matters:** The single biggest thing separating a contacts database from a CRM is interaction history. Right now, there's no way to see when someone was last contacted or what was discussed without leaving Notion and searching your inbox. Activity logging closes that gap — every contact page becomes a timeline of interactions.

**Expected benefit:** Answer "when did we last talk to this person?" directly in Notion. Enables downstream automations (follow-up reminders, lead scoring) that depend on interaction recency.

**Cost:** None. Office 365 licenses include Microsoft Graph API access. Notion is free for the database.

**Effort:** High. Requires a new Notion database (Activities), OAuth setup for Microsoft Graph in n8n, polling logic with deduplication (don't re-log the same email), and email-to-contact matching. This is the most complex option on the list but also the most transformative.

---

## Option 4: Follow-Up Reminders

**What it does:** Builds on Options 2 and 3. A scheduled workflow identifies contacts who are in an active pipeline stage but have no recent activity (no email exchanged, no record update) within a defined window. It generates a personalized reminder email listing the contact, their pipeline stage, and how long since the last touchpoint.

**Why it matters:** Stale pipeline alerts (Option 2) tell you which deals haven't moved. Follow-up reminders go further by incorporating actual communication history — a deal might look stale in Notion but you emailed the person yesterday. This eliminates false positives and focuses attention on genuinely neglected relationships.

**Expected benefit:** More accurate follow-up prioritization. Reduces the noise of stale alerts by accounting for real interactions.

**Cost:** None.

**Effort:** Low-moderate, but depends on Option 3 (email activity logging) being in place first. Without activity data, this collapses back into Option 2.

---

## Option 5: Internal Lead Scoring

**What it does:** A scheduled workflow computes a score for each contact based on signals already available in Notion:

- Number of pipeline appearances (Sales, Comms, Partner)
- Number of relation links (Client DB, Papers, Book Endorsements)
- Tag diversity (more tags = more touchpoints with the business)
- Mailchimp engagement status (Subscribed vs. Unsubscribed vs. Cleaned)
- Recency of last edit
- Activity count and recency (if Option 3 is implemented)

The score is written to a "Lead Score" number property on the contact record. Contacts can then be sorted or filtered by score in Notion views.

**Why it matters:** Not all contacts are equal, but without scoring they all look the same in a database view. A score surfaces the contacts who are most engaged or most connected to the business, making it easier to prioritize outreach and identify who matters most.

**Expected benefit:** Quick prioritization in Notion views. Over time, patterns emerge — what does a high-scoring contact look like? That informs where to invest relationship-building effort.

**Cost:** None.

**Effort:** Moderate. The scoring logic itself is straightforward (weighted sum in a Code node), but tuning the weights to produce meaningful scores requires iteration. Benefits significantly from Option 3 data.

---

## Approved Sequence

| Priority | Option | Dependency |
|----------|--------|------------|
| 1 | Stale Pipeline Alerts | None |
| 2 | Email Activity Logging | None |
| 3 | Follow-Up Reminders | Option 2 |
| 4 | NOTIONID Mailchimp Guard | None |
| 5 | Internal Lead Scoring | None (enhanced by Option 2) |
