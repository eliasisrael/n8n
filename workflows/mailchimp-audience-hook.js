/**
 * Mailchimp Audience Webhook
 *
 * Webhook endpoint that receives Mailchimp audience events (subscribe,
 * unsubscribe, profile update, cleaned, email changed), maps them to
 * the standard contact format, and upserts into the Notion master
 * contacts database via the Notion Master Contact Upsert sub-workflow.
 *
 * Flow:
 *   1. GET Webhook responds 200 for Mailchimp's URL validation
 *   2. POST Webhook receives form-encoded event data
 *   3. Code node validates shared secret from query parameter
 *   4. Filter drops requests with invalid secrets
 *   5. Code node maps event payload to contact object(s)
 *   6. Filter drops items with no email
 *   7. Execute Workflow calls Notion Master Contact Upsert
 *   8. Respond 200 to Mailchimp after successful upsert
 *
 * Event types handled:
 *   - subscribe: new subscriber → upsert with "Subscribed"
 *   - unsubscribe: removed subscriber → upsert with "Unsubscribed"
 *   - profile: profile updated → upsert with "Subscribed"
 *   - cleaned: hard bounce → upsert with "Cleaned" (email only)
 *   - upemail: email changed → create new email + mark old "Unsubscribed"
 *
 * Mailchimp sends form-encoded POST (application/x-www-form-urlencoded)
 * with bracket notation (data[merges][FNAME]=John). n8n's Express body
 * parser auto-parses this into nested objects.
 *
 * Mailchimp webhook setup:
 *   URL: https://n8n.vennfactory.com/webhook/<path>?secret=<secret>
 *   Events: Subscribes, Unsubscribes, Profile Updates, Cleaned, Email Changed
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The Notion Master Contact Upsert sub-workflow on the server.
const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';

// Shared secret for webhook validation, passed as ?secret= query parameter.
// Stored in .env (gitignored) — baked into the JSON at build time.
const MAILCHIMP_WEBHOOK_SECRET = process.env.MAILCHIMP_WEBHOOK_SECRET;
if (!MAILCHIMP_WEBHOOK_SECRET) {
  throw new Error('Missing MAILCHIMP_WEBHOOK_SECRET in .env');
}

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
// Uses responseMode: 'responseNode' so we only return 200 after a
// successful upsert. If the upsert fails, n8n returns 500 and
// Mailchimp will retry.
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
  { position: [208, 0], typeVersion: 2 },
);

// Gate: drop requests with invalid or missing secrets.
const filterValidSecret = createNode(
  'Filter Valid Secret',
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
          leftValue: '={{ $json.validSecret }}',
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

// Map the Mailchimp event payload into the contact shape expected by the
// upsert sub-workflow. Handles all 5 event types. For upemail, outputs
// two items: one for the new email (Subscribed) and one for the old
// email (Unsubscribed). Uses runOnceForAllItems so we can return
// multiple items from a single input.
const mapToContact = createNode(
  'Map Event to Contact',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
// n8n does NOT parse form-encoded bracket notation into nested objects.
// The body has flat keys like "data[email]", "data[merges][FNAME]", etc.
// Helper to read a flat bracket-notation key from the body.
function get(body, key) {
  return body[key] || "";
}

const items = $input.all();
const results = [];

for (const item of items) {
  const body = item.json.body || {};
  const eventType = body.type;

  // Parse INTERESTS (comma-separated string) into tags array
  const interestsRaw = get(body, "data[merges][INTERESTS]");
  const interests = interestsRaw
    ? interestsRaw.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const baseTags = ["Mailchimp", ...interests];

  if (eventType === "upemail") {
    // Email changed: create new contact + mark old as unsubscribed.
    // upemail payloads have NO merge fields — only old/new email.
    results.push({
      json: {
        email: get(body, "data[new_email]"),
        email_marketing: "Subscribed",
        tags: ["Mailchimp"],
      },
    });
    results.push({
      json: {
        email: get(body, "data[old_email]"),
        email_marketing: "Unsubscribed",
        tags: ["Mailchimp"],
      },
    });
  } else if (eventType === "cleaned") {
    // Cleaned: email bounced or abuse complaint.
    // Minimal payload — only rely on data[email].
    results.push({
      json: {
        email: get(body, "data[email]"),
        email_marketing: "Cleaned",
        tags: ["Mailchimp"],
      },
    });
  } else {
    // subscribe, unsubscribe, profile — all include merge fields.
    const statusMap = {
      subscribe: "Subscribed",
      unsubscribe: "Unsubscribed",
      profile: "Subscribed",
    };

    results.push({
      json: {
        email: get(body, "data[email]"),
        first_name: get(body, "data[merges][FNAME]") || null,
        last_name: get(body, "data[merges][LNAME]") || null,
        company: get(body, "data[merges][COMPANY]") || null,
        phone: get(body, "data[merges][PHONE]") || null,
        street_address: get(body, "data[merges][ADDRESS][addr1]") || null,
        street_address_2: get(body, "data[merges][ADDRESS][addr2]") || null,
        city: get(body, "data[merges][ADDRESS][city]") || null,
        state: get(body, "data[merges][ADDRESS][state]") || null,
        postal_code: get(body, "data[merges][ADDRESS][zip]") || null,
        country: get(body, "data[merges][ADDRESS][country]") || null,
        email_marketing: statusMap[eventType] || "Subscribed",
        tags: baseTags,
      },
    });
  }
}

return results;`,
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
  { position: [832, 0], typeVersion: 2.2 },
);

// Call the Notion Master Contact Upsert sub-workflow.
// Runs once per item — for upemail events this means two calls
// (new email create + old email unsubscribe).
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
  { position: [1040, 0], typeVersion: 1.2 },
);

// Respond 200 to Mailchimp only after the upsert succeeds.
// If the upsert fails, n8n returns 500 and Mailchimp will retry
// (up to 20 times over ~5-8 hours before disabling the webhook).
const respondOk = createNode(
  'Respond OK',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: {
      responseCode: 200,
    },
  },
  { position: [1248, 0], typeVersion: 1.5 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Mailchimp Audience Hook', {
  nodes: [
    webhookGet, webhook, validateSecret, filterValidSecret,
    mapToContact, hasEmail, upsertContact, respondOk,
  ],
  connections: [
    connect(webhook, validateSecret),
    connect(validateSecret, filterValidSecret),
    connect(filterValidSecret, mapToContact),
    connect(mapToContact, hasEmail),
    connect(hasEmail, upsertContact),
    connect(upsertContact, respondOk),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
