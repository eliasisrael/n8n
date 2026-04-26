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
 *   8. Send a transactional confirmation email via Mandrill, using the
 *      branch-specific Mailchimp Transactional template (mc_template_id).
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

// Mandrill credential (n8n "HTTP Custom Auth" type). The credential's JSON
// field is set to { "body": { "key": "<api key>" } } — so n8n injects the
// Mandrill API key into the HTTP Request body at execution time. Keeps the
// key out of the compiled workflow JSON and lets us rotate the key in the
// n8n UI without rebuilding.
const MANDRILL_CREDENTIAL = {
  httpCustomAuth: { id: 'yXBgKBXF39NLq3MJ', name: 'Mandrill Custom Auth' },
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

// Mailchimp Transactional template IDs per branch. These are mc_template_id
// integers (visible in the Mailchimp template editor URL), used with the
// /messages/send-mc-template endpoint. NOT the native-Mandrill template slug
// scheme — that's a different endpoint.
const BRANCH_TEMPLATES = {
  bring_eve: 10119871,  // MDID Bring Eve To Your Team (transactional)
  book_eve:  10119870,  // MDID Book Eve To Speak (transactional)
  equip:     10119869,  // MDID Equip Your Organization (transactional)
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
          leftValue: "={{ $('Has Email?').item.json.opportunity_desc }}",
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
const ctx = $('Has Email?').item.json;
const upserted = $input.item.json;

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
// Send transactional confirmation email via Mandrill for the 3 opportunity
// branches. Template is selected at runtime by branch_source. Failures are
// logged via the Error Handler but don't block the 200 response to Webflow —
// the Notion contact + Sales Pipeline page have already been created, so a
// retry would create duplicates.
//
// We call /messages/send-mc-template directly (not via the n8n Mandrill node)
// because the templates are Mailchimp Transactional templates referenced by
// numeric mc_template_id, and the built-in node only handles native Mandrill
// templates referenced by slug.
// ---------------------------------------------------------------------------

const buildMandrillBody = createNode(
  'Build Mandrill Body',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const ctx = $('Has Email?').item.json;
const templates = ${JSON.stringify(BRANCH_TEMPLATES)};
const mcTemplateId = templates[ctx.branch_source];

// The API key is injected by the HTTP Custom Auth credential on the Send
// Mandrill Template node — no 'key' field here.
//
// Mailchimp Transactional templates only substitute merge tags from
// global_merge_vars (flat array), not from per-recipient merge_vars. Each
// execution has exactly one recipient, so global is functionally per-recipient.
//
// bcc_address copies every send to Eve so she has a record of every
// transactional email the system sends from her account.
const body = {
  mc_template_id: mcTemplateId,
  mc_template_version: 'published',
  message: {
    to: [{ email: ctx.email, type: 'to' }],
    bcc_address: 'eve@vennfactory.com',
    merge: true,
    merge_language: 'mailchimp',
    global_merge_vars: [
      { name: 'FNAME', content: ctx.first_name || '' },
      { name: 'EMAIL', content: ctx.email },
    ],
  },
};

return { json: { requestBody: JSON.stringify(body), mcTemplateId } };`,
  },
  { position: [3136, -208], typeVersion: 2 },
);

const sendMandrillTemplate = createNode(
  'Send Mandrill Template',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://mandrillapp.com/api/1.4/messages/send-mc-template',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpCustomAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: {},
  },
  {
    position: [3344, -208],
    typeVersion: 4.2,
    credentials: MANDRILL_CREDENTIAL,
  },
);
sendMandrillTemplate.retryOnFail = true;
sendMandrillTemplate.onError = 'continueRegularOutput';

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
    // Post-upsert opportunity creation
    hasOpportunity, buildOpportunityBody, createOpportunity,
    buildMandrillBody, sendMandrillTemplate,
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

    // Post-upsert opportunity branch
    connect(upsertContact, hasOpportunity),
    connect(hasOpportunity, buildOpportunityBody, 0),  // true (has opp_desc) → create opportunity
    connect(hasOpportunity, respondOk,            1),  // false (Email Form) → respond immediately
    connect(buildOpportunityBody, createOpportunity),
    connect(createOpportunity, buildMandrillBody),
    connect(buildMandrillBody, sendMandrillTemplate),
    connect(sendMandrillTemplate, respondOk),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
