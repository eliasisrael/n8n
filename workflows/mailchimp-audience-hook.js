/**
 * Mailchimp Audience Webhook
 *
 * Front-end webhook that receives Mailchimp audience events, debounces
 * them via Redis, and publishes to QStash with a 10-second delay. The
 * actual processing happens in mailchimp-audience-processor.js when
 * QStash delivers the callback.
 *
 * This prevents duplicate processing when multiple Mailchimp API calls
 * (e.g., merge field update + tag update) fire near-simultaneous webhooks
 * for the same subscriber.
 *
 * Flow:
 *   1. GET Webhook responds 200 for Mailchimp's URL validation
 *   2. POST Webhook receives form-encoded event data
 *   3. Maintenance check via Redis
 *   4. Validate shared secret from query parameter — invalid → 401 + Stop and Error
 *   5. Extract email + event type for debounce key
 *   6. Redis SET NX EX 10 — first event passes, duplicates dropped
 *   7. Publish to QStash with 10s delay → mailchimp-audience-processor
 *   8. Respond 200 to Mailchimp immediately
 *
 * Event types handled:
 *   - subscribe, unsubscribe, profile, cleaned, upemail
 *
 * Mailchimp sends form-encoded POST (application/x-www-form-urlencoded)
 * with bracket notation (data[merges][FNAME]=John).
 *
 * Mailchimp webhook setup:
 *   URL: https://n8n.vennfactory.com/webhook/<path>?secret=<secret>
 *   Events: Subscribes, Unsubscribes, Profile Updates, Cleaned, Email Changed
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Shared secret for webhook validation, passed as ?secret= query parameter.
const MAILCHIMP_WEBHOOK_SECRET = process.env.MAILCHIMP_WEBHOOK_SECRET;
if (!MAILCHIMP_WEBHOOK_SECRET) {
  throw new Error('Missing MAILCHIMP_WEBHOOK_SECRET in .env');
}

// Upstash Redis for maintenance mode gate + debounce.
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const UPSTASH_URL = stripQuotes(process.env.UPSTASH_REDIS_REST_URL);
if (!UPSTASH_URL) {
  throw new Error('Missing UPSTASH_REDIS_REST_URL in .env');
}

// QStash for delayed delivery to the processor workflow.
const QSTASH_URL = stripQuotes(process.env.QSTASH_URL);
if (!QSTASH_URL) {
  throw new Error('Missing QSTASH_URL in .env');
}

// n8n server credentials for Upstash Redis and QStash (httpHeaderAuth type).
const UPSTASH_CREDENTIAL = { httpHeaderAuth: { id: 'mxEZyivdASDcGG7S', name: 'Upstash Redis (Fulcrum)' } };
const QSTASH_CREDENTIAL = { httpHeaderAuth: { id: '31uVSX3kLzvq1xiT', name: 'QStash (Fulcrum)' } };

// The processor webhook that QStash will call after the delay.
const PROCESSOR_WEBHOOK_URL = 'https://n8n.vennfactory.com/webhook/mailchimp-audience-processor';

// Webhook path — shared by both GET and POST nodes.
const WEBHOOK_PATH = '6a90994c-ebb0-4fb0-be82-010bd6b82745';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// Mailchimp sends a GET request to validate the URL when you first register
// the webhook. This standalone node responds 200 immediately with no
// downstream processing.
const webhookGet = createNode(
  'Mailchimp Validation (GET)',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'GET',
    path: WEBHOOK_PATH,
    responseMode: 'onReceived',
    options: {},
  },
  { position: [0, -200], typeVersion: 2.1 },
);
webhookGet.webhookId = crypto.randomUUID();

// Main webhook: receives form-encoded POST events from Mailchimp.
// Responds 200 immediately after publishing to QStash (or dropping duplicate).
const webhook = createNode(
  'Mailchimp Webhook (POST)',
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

// Maintenance mode gate: HTTP Request to Redis, then IF to branch.
const maintenanceCheck = createNode(
  'Maintenance Check',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: `${UPSTASH_URL}/GET/n8n:maintenance`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: {},
  },
  { position: [200, 0], typeVersion: 4.2, credentials: UPSTASH_CREDENTIAL },
);

const ifMaintenance = createNode(
  'If Maintenance?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: '={{ $json.result }}',
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [400, 0], typeVersion: 2 },
);

// When in maintenance mode, respond 200 immediately.
const respondMaintenance = createNode(
  'Respond OK (Maintenance)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [600, -200], typeVersion: 1.5 },
);

// Restore original webhook payload after the maintenance HTTP Request replaced $json.
const restoreEvent = createNode(
  'Restore Event',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const orig = $('Mailchimp Webhook (POST)').item.json;
return { json: orig };`,
  },
  { position: [600, 0], typeVersion: 2 },
);

// Validate the shared secret from the query string (?secret=...).
const validateSecret = createNode(
  'Validate Secret',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const expectedSecret = "${MAILCHIMP_WEBHOOK_SECRET}";
const receivedSecret = $json.query?.secret || "";

$input.item.json.validSecret = (receivedSecret === expectedSecret);

return $input.item;`,
  },
  { position: [800, 0], typeVersion: 2 },
);

// Gate: branch on secret validity — valid continues, invalid gets 401 + error.
const ifValidSecret = createNode(
  'Valid Secret?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: '={{ $json.validSecret }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1000, 0], typeVersion: 2 },
);

// Respond 401 Unauthorized when secret is invalid.
const respondUnauthorized = createNode(
  'Respond 401 (Bad Secret)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 401 },
  },
  { position: [1200, 200], typeVersion: 1.5 },
);

// Throw error so it gets reported via the Error Handler workflow.
const stopBadSecret = createNode(
  'Stop: Bad Secret',
  'n8n-nodes-base.stopAndError',
  {
    errorType: 'errorMessage',
    errorMessage: '=Mailchimp webhook secret verification failed. Received request from {{ $("Mailchimp Webhook (POST)").item.json.headers?.host || "unknown" }}',
  },
  { position: [1400, 200], typeVersion: 1 },
);

// ---------------------------------------------------------------------------
// Debounce gate — Redis SET NX EX 10
// ---------------------------------------------------------------------------

// Extract email from the webhook body for the debounce key.
// Mailchimp uses flat bracket-notation keys: data[email], data[new_email], etc.
const buildDebounceKey = createNode(
  'Build Debounce Key',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const body = $json.body || {};
const eventType = body.type || "";

// Extract the email that identifies this subscriber
let email = body["data[email]"] || "";
if (eventType === "upemail") {
  // For email changes, debounce on the new email
  email = body["data[new_email]"] || email;
}
email = email.toLowerCase().trim();

if (!email) {
  // No email — can't debounce, let it through
  $input.item.json._debounceKey = "";
  return $input.item;
}

// Build Redis SET NX EX command for Upstash REST API
$input.item.json._debounceKey = email;
$input.item.json._debounceBody = JSON.stringify(
  ["SET", "debounce:mailchimp:" + email, "1", "EX", "10", "NX"]
);

return $input.item;`,
  },
  { position: [1200, 0], typeVersion: 2 },
);

// Redis debounce check — SET NX EX 10
// Returns {"result": "OK"} for first event, {"result": null} for duplicate
const redisDebounce = createNode(
  'Redis Debounce Check',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: UPSTASH_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json._debounceBody }}',
    options: {},
  },
  { position: [1400, 0], typeVersion: 4.2, credentials: UPSTASH_CREDENTIAL },
);

// Gate: Is this the first event in the debounce window?
const isNewEvent = createNode(
  'Is New Event?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: '={{ $json.result }}',
        rightValue: 'OK',
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1600, 0], typeVersion: 2 },
);

// Respond 200 for duplicates — Mailchimp is happy, no processing needed.
const respondDuplicate = createNode(
  'Respond OK (Duplicate)',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [1800, 200], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// QStash publish — delayed delivery to processor
// ---------------------------------------------------------------------------

// Restore original event payload (Redis response replaced $json)
const restoreForPublish = createNode(
  'Restore for Publish',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const orig = $('Build Debounce Key').item.json;
const { _debounceBody, _debounceKey, validSecret, ...event } = orig;
return {
  json: {
    email: _debounceKey,
    event_type: (event.body || {}).type || "",
    original_body: event.body || {},
  }
};`,
  },
  { position: [1800, 0], typeVersion: 2 },
);

// DLQ callback URL — QStash will POST here when a message permanently fails delivery.
const DLQ_CALLBACK_URL = `https://n8n.vennfactory.com/webhook/qstash-dlq`;

// Publish to QStash with 10-second delay.
// QStash will POST to the processor webhook after the delay.
const publishToQStash = createNode(
  'Publish to QStash',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `${QSTASH_URL}/v2/publish/${PROCESSOR_WEBHOOK_URL}`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Upstash-Delay', value: '10s' },
        { name: 'Upstash-Failure-Callback', value: DLQ_CALLBACK_URL },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: {},
  },
  { position: [2000, 0], typeVersion: 4.2, credentials: QSTASH_CREDENTIAL },
);
publishToQStash.retryOnFail = true;

// Respond 200 to Mailchimp after successfully publishing to QStash.
const respondOk = createNode(
  'Respond OK',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [2200, 0], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Mailchimp Audience Hook', {
  nodes: [
    webhookGet, webhook,
    maintenanceCheck, ifMaintenance, respondMaintenance, restoreEvent,
    validateSecret, ifValidSecret, respondUnauthorized, stopBadSecret,
    buildDebounceKey, redisDebounce, isNewEvent, respondDuplicate,
    restoreForPublish, publishToQStash, respondOk,
  ],
  connections: [
    // Maintenance gate
    connect(webhook, maintenanceCheck),
    connect(maintenanceCheck, ifMaintenance),
    connect(ifMaintenance, respondMaintenance, 0, 0),    // true (maintenance on) → respond 200
    connect(ifMaintenance, restoreEvent, 1, 0),          // false (normal) → restore original payload
    connect(restoreEvent, validateSecret),

    // Secret validation — true (valid) continues, false (invalid) → 401 + error
    connect(validateSecret, ifValidSecret),
    connect(ifValidSecret, respondUnauthorized, 1, 0),       // false → respond 401
    connect(respondUnauthorized, stopBadSecret),              // then throw error for Error Handler

    // Debounce gate
    connect(ifValidSecret, buildDebounceKey, 0, 0),          // true (valid) → continue
    connect(buildDebounceKey, redisDebounce),
    connect(redisDebounce, isNewEvent),
    connect(isNewEvent, restoreForPublish, 0, 0),        // true (new) → publish to QStash
    connect(isNewEvent, respondDuplicate, 1, 0),         // false (duplicate) → respond 200

    // QStash publish + respond
    connect(restoreForPublish, publishToQStash),
    connect(publishToQStash, respondOk),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
