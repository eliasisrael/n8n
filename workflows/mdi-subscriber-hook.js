/**
 * MDI Subscriber Hook
 *
 * Webhook endpoint that receives Webflow subscriber signup events,
 * validates them with HMAC-SHA256 signature verification, and upserts
 * the subscriber into the Notion master contacts database via the
 * Notion Master Contact Upsert sub-workflow.
 *
 * Flow:
 *   1. Webhook receives POST from Webflow
 *   2. Code node validates HMAC-SHA256 signature
 *   3. Filter drops untrusted payloads
 *   4. Code node maps Webflow payload → contact fields
 *   5. Execute Workflow calls Notion Master Contact Upsert
 *
 * The sub-workflow handles lookup, merge, and create/update logic.
 * Tags are unioned (not replaced) on existing contacts, so the
 * "Launch team" tag is additive.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The Notion Master Contact Upsert sub-workflow on the server.
const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';

// Webflow HMAC verification key for signature validation.
// Stored in .env (gitignored) — baked into the JSON at build time.
const WEBFLOW_VERIFICATION_KEY = process.env.WEBFLOW_VERIFICATION_KEY;
if (!WEBFLOW_VERIFICATION_KEY) {
  throw new Error('Missing WEBFLOW_VERIFICATION_KEY in .env');
}

// Preserve the existing webhook path so the URL doesn't change.
const WEBHOOK_PATH = '57fd52a5-ee6b-466e-a4bf-adae42cfd918';

// ---------------------------------------------------------------------------
// Nodes
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

// Validate the Webflow webhook signature using HMAC-SHA256.
// Adds `trustedPayload` (boolean) to the item JSON.
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

// Gate: drop requests with invalid signatures.
const filterTrusted = createNode(
  'Filter Trusted Payload',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.trustedPayload }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [416, 0], typeVersion: 2.2 },
);

// Map the Webflow payload into the contact shape expected by the upsert
// sub-workflow: { email, tags, email_marketing, ... }
// Only fields relevant to this webhook are set; the sub-workflow skips
// null/missing fields on create and leaves them untouched on update.
const mapToContact = createNode(
  'Map to Contact',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const email = $json.body?.payload?.data?.Email || "";

return {
  json: {
    email,
    tags: ["Launch team"],
    email_marketing: "Subscribed",
  },
};`,
  },
  { position: [624, 0], typeVersion: 2 },
);

// Drop records with no email — avoids an unnecessary sub-workflow call.
const hasEmail = createNode(
  'Has Email?',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.email }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [728, 0], typeVersion: 2.2 },
);

// Call the Notion Master Contact Upsert sub-workflow.
// The sub-workflow receives the mapped contact JSON and handles
// lookup, merge (with tag union), and create/update.
const upsertContact = createNode(
  'Upsert Contact',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: UPSERT_WORKFLOW_ID,
      mode: 'id',
    },
    options: {},
  },
  { position: [936, 0], typeVersion: 1.2 },
);

// Respond 200 to Webflow only after the upsert succeeds.
// The Webhook node uses responseMode: 'responseNode', so if the upsert
// fails, n8n returns a 500 and Webflow can retry.
const respondOk = createNode(
  'Respond OK',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: {
      responseCode: 200,
    },
  },
  { position: [1144, 0], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('MDI Subscriber Hook', {
  nodes: [webhook, validateSignature, filterTrusted, mapToContact, hasEmail, upsertContact, respondOk],
  connections: [
    connect(webhook, validateSignature),
    connect(validateSignature, filterTrusted),
    connect(filterTrusted, mapToContact),
    connect(mapToContact, hasEmail),
    connect(hasEmail, upsertContact),
    connect(upsertContact, respondOk),
  ],
});
