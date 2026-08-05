/**
 * MDI Subscriber Hook
 *
 * Webhook endpoint that receives Webflow form-submission events. The
 * workflow branches on `body.payload.name` to handle 4 distinct form
 * types plus an unknown-name fallthrough:
 *
 *   - "Email Form"             — newsletter signup (existing behavior,
 *                                 cutover-gated tags).
 *   - "Bring Eve to my team"   — creates a Notion Sales Pipeline
 *                                 opportunity ("Executive Briefing").
 *   - "Book Eve to speak"      — creates a Notion Sales Pipeline
 *                                 opportunity ("Public Speaking").
 *   - "Equip my organization" — creates a Notion Sales Pipeline
 *                                 opportunity ("Equip Organization").
 *   - unknown name             — 200 OK to the webhook + Stop-and-Error
 *                                 so the Error Handler logs the unknown
 *                                 form name for triage.
 *
 * Shared flow across the 4 known branches:
 *   1. Validate HMAC-SHA256 Webflow signature → 401 + Stop on failure.
 *   2. Switch on body.payload.name (exact match).
 *   3. Per-branch Map Contact Set node normalizes the payload into a
 *      unified shape { email, first_name, last_name, tags,
 *      email_marketing, opportunity_desc, message, submitter_name,
 *      branch_source }.
 *   4. Has Email? filter drops rows without email.
 *   5. UserCheck email validation (4xx = drop, 5xx = bypass).
 *   6. Upsert to Notion master contacts via sub-workflow.
 *
 * The 3 opportunity-creating branches then:
 *   7. Create a Sales Pipeline page with:
 *        Name           = "{submitter} — {opportunity_desc}"
 *        Master contacts = [contact page id]   (relation, from upsert result)
 *        Status         = "Captured 5%"
 *        Lead source    = "Website form"
 *      Children: one paragraph block containing the Message, if present.
 *   8. Send a branded confirmation email from Eve's mailbox (Graph
 *      /me/sendMail), using the branch-specific subject + clean HTML.
 *      Webflow is answered (200) as soon as the pipeline page is created, so a
 *      send failure surfaces via the error workflow without causing a retry.
 *
 * Email Form branch skips steps 7–8 and responds 200 immediately after
 * the upsert.
 *
 * Cutover date (April 23 2026): only the Email Form branch swaps tags
 * from ["Launch team"] to ["MDID", "Bonus chapter"]. The 3 new branches
 * use fixed per-branch tags regardless of date.
 *
 * Tag union: the upsert sub-workflow merges incoming tags into existing
 * ones, so a single contact submitting multiple forms accumulates tags
 * (e.g., "Launch team" + "BookEveToSpeak") rather than overwriting.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function schemaField(id, type = 'string', extra = {}) {
  return {
    id,
    displayName: id,
    required: false,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The Notion Master Contact Upsert sub-workflow on the server.
const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';

// Notion database IDs
const CONTACTS_DB_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';
const SALES_PIPELINE_DB_ID = '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f';

// Notion API credential (same as upsert-contact.js)
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };

// Webflow HMAC verification key for signature validation.
// Stored in .env (gitignored) — baked into the JSON at build time.
const WEBFLOW_VERIFICATION_KEY = process.env.WEBFLOW_VERIFICATION_KEY;
if (!WEBFLOW_VERIFICATION_KEY) {
  throw new Error('Missing WEBFLOW_VERIFICATION_KEY in .env');
}

// Confirmation emails send from Eve's Microsoft 365 mailbox via Graph
// /me/sendMail (same credential the other email workflows use), replacing the
// old Mandrill/Mailchimp-template path — lower volume, no template dependency,
// and it comes personally from Eve (the templates are signed "Best, Eve").
const OUTLOOK_CREDENTIAL = {
  microsoftOutlookOAuth2Api: { id: 'xUInnrPuP6ogucEt', name: 'Microsoft Outlook account' },
};

// Preserve the existing webhook path so the URL doesn't change.
const WEBHOOK_PATH = '57fd52a5-ee6b-466e-a4bf-adae42cfd918';

// Form-name branch definitions (for the 3 new opportunity-creating branches).
// Matched by exact string equality against $json.body.payload.name.
const BRANCHES = [
  { key: 'bring_eve',  name: 'Bring Eve to my team',    tag: 'BringEve',          desc: 'Executive Briefing' },
  { key: 'book_eve',   name: 'Book Eve to speak',        tag: 'BookEveToSpeak',    desc: 'Public Speaking' },
  { key: 'equip',      name: 'Equip my organization',    tag: 'BulkBookPurchase',  desc: 'Equip Organization' },
];

// Per-branch confirmation email = subject + HTML. The copy is verbatim from the
// Mailchimp templates (originals archived in git history), but rebuilt as clean,
// email-safe HTML: a single full-width table, inline styles only, no <style>-block
// dependency, no media queries, no deep table nesting, no white-space:pre-wrap.
//
// Why not send the raw Mailchimp export: Exchange sanitizes/reflows outbound HTML
// on Graph /me/sendMail, and Mailchimp's ~15-level nested content block (which
// relies on the stripped <head> <style>) collapses — text wrapped after 2–3
// words in the delivered mail. The simpler signature table survived intact, which
// is the pattern this rebuild follows. {{FNAME}} is substituted by Build Email.
const CALENDLY = 'https://calendly.com/eve-vennfactory/discovery-call-work-with-eve';
const LOGO_URL = 'https://mcusercontent.com/e0aa8680af271a6c83ca25927/images/56f35f7d-6d51-3f42-2d43-d443ae66cda9.png';

const P = (inner) => `<p style="margin:0 0 16px 0;">${inner}</p>`;
const CALL = (label) => `<a href="${CALENDLY}" style="color:#4183c4;">${label}</a>`;

// Signature — the block that already rendered correctly, kept simple.
const SIGNATURE = `
<img src="${LOGO_URL}" width="211" alt="Eve Maler" style="display:block;border:0;outline:none;text-decoration:none;width:211px;max-width:211px;height:auto;margin:8px 0 12px 0;">
<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;color:#3c584d;">President &amp; Founder, Venn Factory<br>Digital Identity Strategist<br>Author &amp; Speaker<br>Board Member</div>
<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#3c584d;font-weight:bold;padding-top:12px;">Cell and Signal: <a href="tel:+14253456756" style="color:#3c584d;text-decoration:none;">+1 (425) 345-6756</a></div>
<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#3c584d;padding-top:8px;"><a href="https://masteringdigitalidentity.com/" style="color:#3c584d;font-weight:bold;">Sign up</a> to receive updates about Eve’s new book, <em>Mastering Digital Identity</em></div>`;

// Full-width personal-email shell: no centered card / max-width cap, so the body
// uses the client's full reading width and reads like a normal note from Eve —
// not a newsletter. A single 100%-width table with a padded cell keeps a little
// breathing room from the edges (body padding is ignored by Outlook's Word
// engine, but td padding is honored). Body text is 16px/24px #333 Helvetica.
const shell = (body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding:20px 28px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#333333;">
${body}
<div style="padding-top:8px;">${SIGNATURE}</div>
</td></tr></table>
</body></html>`;

const BODY_BRING_EVE = [
  P('Hi {{FNAME}},'),
  P('Thanks for reaching out — I’m glad you did.'),
  P('Working directly with leadership teams is where the frameworks in <em>Mastering Digital Identity</em> get traction fastest. Two formats worth considering:'),
  P('<strong>Leadership Alignment Session</strong> <em>(5–10 participants)</em>'),
  P('A 90-minute facilitated session applying the Identity Product Ownership lens to your organization. It includes customized executive discussion prompts, an executive asset (such as an Identity Ownership Maturity self-assessment), a limited-edition branded asset (think “swag”), and a signed copy of the book for each participant.'),
  P('This format is designed for teams that want to assess where they stand and align on a direction — without a lengthy run-up.'),
  P('<strong>90-Day Executive Coaching Engagement</strong>'),
  P('A sustained working relationship — typically with a CISO, CPO, or senior identity program owner — focused on building identity product ownership capability inside your organization. We work through the framework together, applied to your specific context and timeline.'),
  P('I’ll follow up personally to understand what you’re navigating and which approach fits. Reply with anything that would help me come prepared — or ' + CALL('book a discovery call') + ' if that’s easier.'),
  P('Best,<br>Eve'),
].join('\n');

const BODY_BOOK_EVE = [
  P('Hi {{FNAME}},'),
  P('Thanks for reaching out — I’m glad the book prompted you to get in touch.'),
  P('Over the past year, I’ve spoken at SXSW, and keynoted at the European Identity &amp; Cloud Conference, and executive gatherings ranging from practitioner forums to client advisory councils. The book has added a new dimension to those conversations: a structured way to bring identity strategy into the room, not just identity awareness.'),
  P('Here are three formats that work well for different audiences and contexts:'),
  P('<strong>Executive Book Reading</strong> <em>(10–40 participants)</em>'),
  P('A 30-minute in-person reading with executive commentary and facilitated discussion. Includes an executive asset and signed book copies for participants. Well suited to board meetings, executive team offsites, client advisory councils, and partner gatherings.'),
  P('<strong>Enterprise Activation</strong> <em>(50+ participants)</em>'),
  P('A keynote or executive-sponsored town hall built around a book theme, designed to inspire and galvanize. Includes an optional follow-on advisory session and signed book copies for participants.'),
  P('<strong>Conference &amp; Client Forum Activation</strong>'),
  P('The full live <em>Mastering Digital Identity</em> experience: keynote, optional VIP roundtable or fireside chat, limited-edition assets, and signed book copies for participants.'),
  P('Tell me about your event and audience — or ' + CALL('book a discovery call') + ' if that’s easier. I’ll follow up with a recommendation once I understand the context.'),
  P('Best,<br>Eve'),
].join('\n');

const BODY_EQUIP = [
  P('Hi {{FNAME}},'),
  P('Thanks for reaching out.'),
  P('One question before I point you in the right direction: is there an event or gathering you have in mind — a team offsite, board meeting, conference, or client session — or are you primarily looking to get copies into people’s hands for independent reading?'),
  P('The answer shapes what’s available. If there’s an event, I can build a full experience around it, including facilitation materials and signed copies. If it’s a standalone order, I can point you to where to buy.'),
  P('Reply here, or ' + CALL('book a discovery call') + ' if you’d like to talk it through.'),
  P('Best,<br>Eve'),
].join('\n');

const BRANCH_EMAILS = {
  bring_eve: { subject: "Thanks for reaching out — here's how we can work together", html: shell(BODY_BRING_EVE) },
  book_eve:  { subject: "Thanks for reaching out — let's talk about your event",     html: shell(BODY_BOOK_EVE) },
  equip:     { subject: 'Thanks for reaching out — one question first',              html: shell(BODY_EQUIP) },
};

// ---------------------------------------------------------------------------
// Trigger + signature validation (unchanged)
// ---------------------------------------------------------------------------

const webhook = createNode(
  'Webhook',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: WEBHOOK_PATH,
    responseMode: 'responseNode',
    options: {},
  },
  { position: [0, 0], typeVersion: 2.1 },
);
webhook.webhookId = WEBHOOK_PATH;

const validateSignature = createNode(
  'Validate Signature',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
let crypto = require("crypto");

let verificationKey = "${WEBFLOW_VERIFICATION_KEY}";

const requestTimestamp = parseInt($input.item.json.headers["x-webflow-timestamp"], 10);
const requestBody = JSON.stringify($input.item.json.body);

const data = \`\${requestTimestamp}:\${requestBody}\`;

const calculatedSignature = crypto
  .createHmac("sha256", verificationKey)
  .update(data)
  .digest("hex");

const isTrustedPayload =
  calculatedSignature === $input.item.json.headers["x-webflow-signature"];

$input.item.json.calculatedSig = calculatedSignature;
$input.item.json.trustedPayload = isTrustedPayload;

return $input.item;`,
  },
  { position: [208, 0], typeVersion: 2 },
);

const ifTrusted = createNode(
  'Trusted Payload?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: '={{ $json.trustedPayload }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [416, 0], typeVersion: 2 },
);

const respondUnauthorized = createNode(
  'Respond 401 (Bad Signature)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 401 },
  },
  { position: [624, 800], typeVersion: 1.5 },
);

const stopBadSignature = createNode(
  'Stop: Bad Signature',
  'n8n-nodes-base.stopAndError',
  {
    errorMessage: '=Webflow webhook HMAC signature verification failed. Received request from {{ $("Webhook").item.json.headers?.host || "unknown" }}',
  },
  { position: [832, 800], typeVersion: 1 },
);

// ---------------------------------------------------------------------------
// Router: Switch on body.payload.name (exact match, fallback = unknown)
// ---------------------------------------------------------------------------
//
// Outputs (0-indexed):
//   0 — "Email Form"              → Email Form branch (existing behavior)
//   1 — "Bring Eve to my team"    → Bring Eve branch
//   2 — "Book Eve to speak"       → Book Eve branch
//   3 — "Equip my organization"   → Equip branch
//   4 — fallback (extra)          → Unknown name path

function nameMatchRule(value, outputKey) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.body.payload.name }}',
          rightValue: value,
          operator: { type: 'string', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey,
  };
}

// Note: the legacy name check used substring "Email Form"; new router uses
// exact equality. If Webflow sometimes sends a different exact string for
// the newsletter form, update the value below.
const routeByName = createNode(
  'Route by Name',
  'n8n-nodes-base.switch',
  {
    rules: {
      values: [
        nameMatchRule('Email Form',              'Email Form'),
        nameMatchRule('Bring Eve to my team',    'Bring Eve'),
        nameMatchRule('Book Eve to speak',       'Book Eve'),
        nameMatchRule('Equip my organization',   'Equip'),
      ],
    },
    options: { fallbackOutput: 'extra' },
  },
  { position: [624, 0], typeVersion: 3.2 },
);

// ---------------------------------------------------------------------------
// Email Form branch (existing behavior, preserved as-is aside from layout)
// ---------------------------------------------------------------------------

const mapEmailForm = createNode(
  'Map: Email Form',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'email',
          value: '={{ $json.body?.payload?.data?.Email || "" }}',
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'email_marketing',
          value: 'Subscribed',
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'branch_source',
          value: 'email_form',
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [832, -600], typeVersion: 3.4 },
);

const afterCutover = createNode(
  'After Cutover?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ new Date($now) }}',
          rightValue: '={{ new Date("2026-04-23T00:00:00Z") }}',
          operator: { type: 'dateTime', operation: 'afterOrEquals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1040, -600], typeVersion: 2.2 },
);

const setMdidTags = createNode(
  'Set MDID Tags',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'tags',
          value: '={{ ["MDID", "Bonus chapter"] }}',
          type: 'array',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  { position: [1248, -700], typeVersion: 3.4 },
);

const setLaunchTags = createNode(
  'Set Launch Tags',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'tags',
          value: '={{ ["Launch team"] }}',
          type: 'array',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  { position: [1248, -500], typeVersion: 3.4 },
);

// ---------------------------------------------------------------------------
// 3 new branches — each has its own Map node that produces the unified shape.
// Email is at body.payload.data["Email Address"] (NOT Email as on Email Form).
// Name splits into first_name / last_name; Message passes through for later
// use as the Sales Pipeline page's body paragraph.
// ---------------------------------------------------------------------------

function makeBranchMapNode({ key, tag, desc }, y) {
  const displayName = key
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return createNode(
    `Map: ${displayName}`,
    'n8n-nodes-base.set',
    {
      assignments: {
        assignments: [
          {
            id: crypto.randomUUID(),
            name: 'email',
            value: '={{ $json.body?.payload?.data?.["Email Address"] || "" }}',
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'submitter_name',
            value: '={{ ($json.body?.payload?.data?.Name || "").trim() }}',
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'first_name',
            value: '={{ (($json.body?.payload?.data?.Name || "").trim().split(/\\s+/)[0]) || "" }}',
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'last_name',
            value: '={{ (() => { const parts = ($json.body?.payload?.data?.Name || "").trim().split(/\\s+/); return parts.length > 1 ? parts.slice(1).join(" ") : ""; })() }}',
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'message',
            value: '={{ $json.body?.payload?.data?.Message || "" }}',
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'tags',
            value: `={{ ${JSON.stringify([tag])} }}`,
            type: 'array',
          },
          {
            id: crypto.randomUUID(),
            name: 'opportunity_desc',
            value: desc,
            type: 'string',
          },
          {
            id: crypto.randomUUID(),
            name: 'branch_source',
            value: key,
            type: 'string',
          },
        ],
      },
      options: {},
    },
    { position: [832, y], typeVersion: 3.4 },
  );
}

// Three new-branch Map nodes, vertically stacked.
const mapBringEve = makeBranchMapNode(BRANCHES[0], -200);
const mapBookEve  = makeBranchMapNode(BRANCHES[1],    0);
const mapEquip    = makeBranchMapNode(BRANCHES[2],  200);

// ---------------------------------------------------------------------------
// Unknown-name branch: respond 200 (so Webflow doesn't retry) + Stop-and-Error
// with a descriptive message so the Error Handler logs the unknown form name.
// ---------------------------------------------------------------------------

const respondOkUnknown = createNode(
  'Respond 200 (Unknown)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [832, 480], typeVersion: 1.5 },
);

const stopUnknownName = createNode(
  'Stop: Unknown Name',
  'n8n-nodes-base.stopAndError',
  {
    errorMessage: '=MDI Subscriber Hook received unknown form name: "{{ $json.body?.payload?.name || "(missing)" }}". Add a branch for this form or update the router.',
  },
  { position: [1040, 480], typeVersion: 1 },
);

// ---------------------------------------------------------------------------
// Shared downstream: Has Email? → UserCheck → Email Valid? / Service Down?
// ---------------------------------------------------------------------------

const hasEmail = createNode(
  'Has Email?',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.email }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1472, 0], typeVersion: 2.2 },
);

const validateEmail = createNode(
  'Validate Email',
  'n8n-nodes-base.httpRequest',
  {
    url: '=https://api.usercheck.com/email/{{ encodeURI($json.email) }}',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendQuery: true,
    queryParameters: { parameters: [{}] },
    options: {},
  },
  {
    position: [1680, 0],
    typeVersion: 4.2,
    credentials: { httpHeaderAuth: { id: 'sGklpGDze5oWu3MF', name: 'UserCheck API' } },
  },
);
validateEmail.retryOnFail = true;
validateEmail.onError = 'continueErrorOutput';

const emailValid = createNode(
  'Email Valid?',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.mx }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.spam }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'false', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1888, 0], typeVersion: 2.2 },
);

const serviceDown = createNode(
  'Service Down?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.statusCode || 500 }}',
          rightValue: '500',
          operator: { type: 'number', operation: 'gte' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1888, 208], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// Upsert to Notion master contacts
// ---------------------------------------------------------------------------
// Schema declares all fields the 4 branches may send. Fields that a branch
// doesn't set (e.g. first_name on Email Form) will be empty strings; the
// sub-workflow's null/empty handling leaves those untouched on updates.

const upsertContact = createNode(
  'Upsert Contact',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: UPSERT_WORKFLOW_ID,
      mode: 'id',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        email:           "={{ $('Has Email?').item.json.email }}",
        first_name:      "={{ $('Has Email?').item.json.first_name }}",
        last_name:       "={{ $('Has Email?').item.json.last_name }}",
        tags:            "={{ $('Has Email?').item.json.tags }}",
        email_marketing: "={{ $('Has Email?').item.json.email_marketing }}",
      },
      matchingColumns: [],
      schema: [
        schemaField('email'),
        schemaField('first_name'),
        schemaField('last_name'),
        schemaField('tags', 'array'),
        schemaField('email_marketing'),
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {},
  },
  { position: [2096, 0], typeVersion: 1.2 },
);

// ---------------------------------------------------------------------------
// Re-pair the mapped fields onto the upsert result.
//
// Upsert Contact is an Execute Workflow (data-replacing) whose output carries
// only the contact record (id/page_id/email/…) and — critically — a corrupted
// pairedItem, so any downstream `$('Has Email?').item` resolves EMPTY. That
// silently sent every opportunity submission down the "no opportunity" branch:
// no Sales Pipeline page, no Mandrill email.
//
// Fix per GENERAL-LESSONS ("item pairing breaks across data-replacing nodes"):
// join the upsert output (input 1) with the Has Email? items (input 2) on
// `email`, so each contact row regains its opportunity_desc / submitter_name /
// message / branch_source / first_name. Field-based (not position/`.first()`)
// so it stays correct when a webhook delivers MULTIPLE subscribers — each row
// is paired by its own email, independent of order or of rows the Email Valid?
// filter dropped upstream.
const mergeContactFields = createNode(
  'Merge Contact + Fields',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    fieldsToMatchString: 'email',
    joinMode: 'enrichInput1',   // keep every upserted contact, add its mapped fields
    options: {},
  },
  { position: [2200, 200], typeVersion: 3 },
);

// ---------------------------------------------------------------------------
// Post-upsert branch: 3 new branches diverge to create a Sales Pipeline
// opportunity; Email Form branch short-circuits to Respond OK.
// Gate = opportunity_desc is non-empty (only the 3 new branches set it).
// ---------------------------------------------------------------------------

const hasOpportunity = createNode(
  'Has Opportunity?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: crypto.randomUUID(),
          // Read the merged item directly ($json), not $('Has Email?').item —
          // the latter is empty here because Upsert Contact broke the pairing.
          leftValue: '={{ $json.opportunity_desc }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2304, 0], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// Build the Notion create-page request body for the Sales Pipeline DB.
// Pulls:
//   - Opportunity title from $('Has Email?') (submitter_name + opportunity_desc)
//   - Master contacts relation from the Upsert Contact result (page id)
//   - Message (if non-empty) as a child paragraph block
// Using a Code node (rather than Set) because the children array is
// conditional on Message being present, and the nested Notion API shape is
// more readable as JS than as nested Set assignments.
// ---------------------------------------------------------------------------

const buildOpportunityBody = createNode(
  'Build Opportunity Body',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
// Merge Contact + Fields put the upsert result AND the mapped fields on one
// item, so read both from $json (paired per-item; safe for multi-item webhooks).
const ctx = $json;
const upserted = $json;

const submitterName = (ctx.submitter_name || '').trim();
const desc = (ctx.opportunity_desc || '').trim();
const message = (ctx.message || '').trim();

// Title: "{submitter} — {desc}" if submitter present, else just desc.
const title = submitterName ? \`\${submitterName} — \${desc}\` : desc;

// Contact page id from the upsert sub-workflow's normalized return shape.
const contactPageId = upserted?.id || upserted?.page_id || null;

const properties = {
  Name: { title: [{ type: 'text', text: { content: title } }] },
  Status: { status: { name: 'Captured 5%' } },
  'Lead source': { select: { name: 'Website form' } },
};

if (contactPageId) {
  properties['Master contacts'] = { relation: [{ id: contactPageId }] };
}

const body = {
  parent: { database_id: '${SALES_PIPELINE_DB_ID}' },
  properties,
};

// Attach the form Message as a child paragraph block, if present.
if (message) {
  body.children = [{
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: message } }],
    },
  }];
}

return { json: { requestBody: JSON.stringify(body), contactPageId, title } };`,
  },
  { position: [2720, -208], typeVersion: 2 },
);

const createOpportunity = createNode(
  'Create Sales Pipeline Page',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Notion-Version', value: '2022-06-28' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: {},
  },
  {
    position: [2928, -208],
    typeVersion: 4.2,
    credentials: NOTION_CREDENTIAL,
  },
);
createOpportunity.retryOnFail = true;

// ---------------------------------------------------------------------------
// Send the branded confirmation email from Eve's mailbox (Graph /me/sendMail)
// for the 3 opportunity branches. Subject + HTML are selected by branch_source.
//
// Error handling: the webhook already responded 200 (Respond OK fires off Create
// Sales Pipeline Page, in parallel with this path), so a send failure can surface
// LOUDLY without triggering a Webflow retry / duplicate. Send Email therefore
// uses n8n's default onError (stop → error workflow), unlike the old Mandrill
// node whose continueRegularOutput silently swallowed a 500.
// ---------------------------------------------------------------------------

const buildEmail = createNode(
  'Build Email',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
// This node sits AFTER Build Opportunity Body + Create Sales Pipeline Page, both
// of which replace the item — so $json here is the Notion page response, NOT the
// mapped fields. Read them from the Merge output via a PAIRED reference: the
// chain back to the merge crosses only Code/HTTP/IF nodes (which preserve
// pairedItem), never an Execute Workflow, so .item resolves correctly and stays
// right when a webhook carries multiple subscribers (unlike .first()).
const ctx = $('Merge Contact + Fields').item.json;
const EMAILS = ${JSON.stringify(BRANCH_EMAILS)};
const tpl = EMAILS[ctx.branch_source];
// Only the 3 opportunity branches reach here (they set branch_source); a missing
// template is a real defect, so fail loudly rather than send a blank email.
if (!tpl) throw new Error('No confirmation-email template for branch_source: ' + ctx.branch_source);

const firstName = String(ctx.first_name || '').trim() || 'there';
const html = tpl.html.split('{{FNAME}}').join(firstName);

const body = {
  message: {
    subject: tpl.subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: ctx.email } }],
  },
  saveToSentItems: true,   // keeps Eve's copy in Sent (replaces the old bcc)
};

return { json: { requestBody: JSON.stringify(body) } };`,
  },
  { position: [3136, -208], typeVersion: 2 },
);

const sendEmail = createNode(
  'Send Confirmation Email',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://graph.microsoft.com/v1.0/me/sendMail',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: {},
  },
  {
    position: [3344, -208],
    typeVersion: 4.2,
    credentials: OUTLOOK_CREDENTIAL,
  },
);
sendEmail.retryOnFail = true;
sendEmail.maxTries = 3;
sendEmail.waitBetweenTries = 2000;
// No onError override: a send that still fails after retries stops the workflow
// and fires the error handler (surfaced, not swallowed). Safe because Respond OK
// has already answered Webflow off the Create Sales Pipeline Page branch.

// ---------------------------------------------------------------------------
// Shared terminal: respond 200 OK after both paths complete.
// ---------------------------------------------------------------------------

const respondOk = createNode(
  'Respond OK',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: {
      responseCode: 200,
    },
  },
  { position: [3552, 0], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('MDI Subscriber Hook', {
  nodes: [
    webhook, validateSignature, ifTrusted, respondUnauthorized, stopBadSignature,
    routeByName,
    // Email Form branch
    mapEmailForm, afterCutover, setMdidTags, setLaunchTags,
    // 3 new branches
    mapBringEve, mapBookEve, mapEquip,
    // Unknown name
    respondOkUnknown, stopUnknownName,
    // Shared downstream
    hasEmail, validateEmail, emailValid, serviceDown, upsertContact,
    mergeContactFields,
    // Post-upsert opportunity creation
    hasOpportunity, buildOpportunityBody, createOpportunity,
    buildEmail, sendEmail,
    respondOk,
  ],
  connections: [
    // Trigger → signature → trust gate
    connect(webhook, validateSignature),
    connect(validateSignature, ifTrusted),
    connect(ifTrusted, routeByName, 0, 0),
    connect(ifTrusted, respondUnauthorized, 1, 0),
    connect(respondUnauthorized, stopBadSignature),

    // Router → 4 known branches + fallback (Unknown)
    connect(routeByName, mapEmailForm,     0, 0),
    connect(routeByName, mapBringEve,      1, 0),
    connect(routeByName, mapBookEve,       2, 0),
    connect(routeByName, mapEquip,         3, 0),
    connect(routeByName, respondOkUnknown, 4, 0),
    connect(respondOkUnknown, stopUnknownName),

    // Email Form branch: cutover → tag setter → Has Email?
    connect(mapEmailForm, afterCutover),
    connect(afterCutover, setMdidTags,   0),
    connect(afterCutover, setLaunchTags, 1),
    connect(setMdidTags,   hasEmail),
    connect(setLaunchTags, hasEmail),

    // 3 new branches → Has Email?
    connect(mapBringEve, hasEmail),
    connect(mapBookEve,  hasEmail),
    connect(mapEquip,    hasEmail),

    // Shared downstream: email validation → upsert
    connect(hasEmail, validateEmail),
    connect(validateEmail, emailValid,  0),
    connect(validateEmail, serviceDown, 1),
    connect(emailValid,  upsertContact),
    connect(serviceDown, upsertContact, 0),
    // serviceDown false (4xx) → bad email, silently dropped

    // Re-pair mapped fields onto the upsert result (join on email), then gate.
    connect(upsertContact, mergeContactFields, 0, 0),  // upserted contacts → input 1
    connect(hasEmail,      mergeContactFields, 0, 1),  // mapped fields → input 2
    connect(mergeContactFields, hasOpportunity),

    // Post-upsert opportunity branch
    connect(hasOpportunity, buildOpportunityBody, 0),  // true (has opp_desc) → create opportunity
    connect(hasOpportunity, respondOk,            1),  // false (Email Form) → respond immediately
    connect(buildOpportunityBody, createOpportunity),
    // Once the Sales Pipeline page exists, answer Webflow (200) AND send the
    // email in parallel. Responding first means an email failure surfaces via
    // the error workflow without making Webflow retry (which would duplicate the
    // contact + page).
    connect(createOpportunity, respondOk),
    connect(createOpportunity, buildEmail),
    connect(buildEmail, sendEmail),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
