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
 *   3. IF node gates on signature — invalid → 401 response + Stop and Error
 *   4. Code node maps Webflow payload → contact fields
 *   5. UserCheck validates email (syntax, MX, spam)
 *      — 4xx error (bad email) → silently dropped
 *      — 5xx error (outage) → bypasses to upsert
 *   6. Execute Workflow calls Notion Master Contact Upsert
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

// Gate: branch on signature validity — trusted continues, untrusted gets 401 + error.
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

// Respond 401 Unauthorized when signature is invalid.
const respondUnauthorized = createNode(
  'Respond 401 (Bad Signature)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 401 },
  },
  { position: [624, 200], typeVersion: 1.5 },
);

// Throw error so it gets reported via the Error Handler workflow.
const stopBadSignature = createNode(
  'Stop: Bad Signature',
  'n8n-nodes-base.stopAndError',
  {
    errorType: 'errorMessage',
    errorMessage: '=Webflow webhook HMAC signature verification failed. Received request from {{ $("Webhook").item.json.headers?.host || "unknown" }}',
  },
  { position: [832, 200], typeVersion: 1 },
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
  { position: [848, 0], typeVersion: 2.2 },
);

// Validate the email address via UserCheck API — checks syntax, MX, spam.
// Error output (output 1) routes to Service Down? to distinguish 4xx (bad
// email, drop) from 5xx (outage, bypass to upsert).
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
    position: [1072, 0],
    typeVersion: 4.2,
    credentials: { httpHeaderAuth: { id: 'sGklpGDze5oWu3MF', name: 'UserCheck API' } },
  },
);
validateEmail.retryOnFail = true;
validateEmail.onError = 'continueErrorOutput';

// Email Valid? — require MX record and no spam flag.
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
  { position: [1296, 0], typeVersion: 2.2 },
);

// Service Down? — on UserCheck error, distinguish 4xx (bad email) from 5xx (outage).
// 5xx → bypass to upsert; 4xx → silently drop.
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
  { position: [1296, 200], typeVersion: 2.2 },
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
  { position: [1520, 0], typeVersion: 1.2 },
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
  { position: [1744, 0], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('MDI Subscriber Hook', {
  nodes: [webhook, validateSignature, ifTrusted, respondUnauthorized, stopBadSignature, mapToContact, hasEmail, validateEmail, emailValid, serviceDown, upsertContact, respondOk],
  connections: [
    connect(webhook, validateSignature),
    connect(validateSignature, ifTrusted),
    connect(ifTrusted, mapToContact, 0, 0),                  // true (trusted) → continue
    connect(ifTrusted, respondUnauthorized, 1, 0),            // false (untrusted) → respond 401
    connect(respondUnauthorized, stopBadSignature),            // then throw error for Error Handler
    connect(mapToContact, hasEmail),
    connect(hasEmail, validateEmail),
    connect(validateEmail, emailValid, 0),          // success → mx/spam filter
    connect(validateEmail, serviceDown, 1),         // error → check status code
    connect(emailValid, upsertContact),
    connect(serviceDown, upsertContact, 0),         // true (5xx) → bypass, let through
    // false (4xx) → bad email, silently dropped
    connect(upsertContact, respondOk),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
