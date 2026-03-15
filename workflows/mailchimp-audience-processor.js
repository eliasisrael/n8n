/**
 * Mailchimp Audience Processor
 *
 * QStash callback workflow that processes Mailchimp audience events after
 * a 10-second debounce delay. Called by QStash after mailchimp-audience-hook
 * publishes an event.
 *
 * Because of the delay, this workflow fetches FRESH data from the Mailchimp
 * API rather than relying on the webhook payload (which may be stale if
 * multiple updates happened in quick succession).
 *
 * Flow:
 *   1. POST Webhook receives QStash callback
 *   2. Verify QStash JWT signature
 *   3. Fetch fresh subscriber data from Mailchimp API
 *   4. Map to contact format
 *   5. Upsert to Notion via sub-workflow
 *   6. Respond 200 to QStash
 *
 * For event types that don't have fetchable state (upemail, cleaned),
 * we fall back to the data from the original webhook payload.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';
const MAILCHIMP_LIST_ID = '77d135987f';
const WEBHOOK_PATH = 'mailchimp-audience-processor';

const MAILCHIMP_CREDENTIAL = {
  mailchimpOAuth2Api: { id: 'DtyHZOOulvefkbC3', name: 'Mailchimp account' },
};

// Mailchimp data center — used to build the admin profile URL.
const MAILCHIMP_DC = process.env.MAILCHIMP_DC;
if (!MAILCHIMP_DC) {
  throw new Error('Missing MAILCHIMP_DC in .env');
}

// QStash signing keys for signature verification.
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const QSTASH_CURRENT_KEY = stripQuotes(process.env.QSTASH_CURRENT_SIGNING_KEY) || '';
const QSTASH_NEXT_KEY = stripQuotes(process.env.QSTASH_NEXT_SIGNING_KEY) || '';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Webhook — receives POST from QStash after 10s delay
const webhook = createNode(
  'QStash Callback',
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

// 2. Verify QStash Signature — reuses the same HMAC-SHA256 JWT pattern
//    as the Notion adapters. Error output → 401 (no QStash retry).
const verifySignature = createNode(
  'Verify QStash Signature',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const crypto = require('crypto');

const signature = $json.headers['upstash-signature'];
if (!signature) {
  throw new Error('Missing Upstash-Signature header');
}

const parts = signature.split('.');
if (parts.length !== 3) {
  throw new Error('Invalid JWT format');
}

const [headerB64, payloadB64, sigB64] = parts;
const signingInput = headerB64 + '.' + payloadB64;

const currentKey = '${QSTASH_CURRENT_KEY}';
const nextKey = '${QSTASH_NEXT_KEY}';

function verify(key) {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(signingInput);
  const expected = hmac.digest('base64url');
  return expected === sigB64;
}

if (!verify(currentKey) && !verify(nextKey)) {
  throw new Error('QStash signature verification failed');
}

const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
if (payload.iss !== 'Upstash') {
  throw new Error('Invalid issuer: ' + payload.iss);
}
if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
  throw new Error('Token expired');
}

return { json: $json };`,
  },
  { position: [250, 0], typeVersion: 2 },
);
verifySignature.onError = 'continueErrorOutput';

// 3. Respond 401 — bad/missing QStash signature (no retry)
const respond401 = createNode(
  'Respond 401',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'text',
    responseBody: '={{ $json.message || "Unauthorized" }}',
    options: { responseCode: 401 },
  },
  { position: [500, 200], typeVersion: 1.1 },
);

// 4. Route by event type — some events can fetch fresh data, others can't
//    Output 0: upemail, Output 1: cleaned, Output 2: fetchable (everything else)
const routeByType = createNode(
  'Route by Event Type',
  'n8n-nodes-base.switch',
  {
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{
              id: crypto.randomUUID(),
              leftValue: '={{ $json.body.event_type }}',
              rightValue: 'upemail',
              operator: { type: 'string', operation: 'equals' },
            }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'upemail',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{
              id: crypto.randomUUID(),
              leftValue: '={{ $json.body.event_type }}',
              rightValue: 'cleaned',
              operator: { type: 'string', operation: 'equals' },
            }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'cleaned',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{
              id: crypto.randomUUID(),
              leftValue: '={{ $json.body.event_type }}',
              rightValue: '',
              operator: { type: 'string', operation: 'notEmpty', singleValue: true },
            }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Fetchable',
        },
      ],
    },
    options: {},
  },
  { position: [500, 0], typeVersion: 3.2 },
);

// ---------------------------------------------------------------------------
// Fetchable events path (subscribe, unsubscribe, profile)
// These have a stable email we can use to GET fresh data from Mailchimp.
// ---------------------------------------------------------------------------

// 5a. Fetch fresh subscriber from Mailchimp API
const fetchSubscriber = createNode(
  'Fetch Subscriber',
  'n8n-nodes-base.mailchimp',
  {
    authentication: 'oAuth2',
    operation: 'get',
    list: MAILCHIMP_LIST_ID,
    email: '={{ $json.body.email }}',
    options: {},
  },
  { position: [750, 0], typeVersion: 1, credentials: MAILCHIMP_CREDENTIAL },
);
fetchSubscriber.retryOnFail = true;
fetchSubscriber.onError = 'continueRegularOutput';

// 5b. Map fresh Mailchimp data to contact format
const mapFreshData = createNode(
  'Map Fresh Data',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const MC_DC = "${MAILCHIMP_DC}";

const items = $input.all();
const results = [];

for (const item of items) {
  const mc = item.json;
  const eventType = $('Route by Event Type').item.json.body.event_type || "profile";

  // If Mailchimp GET failed (no id), fall back to original payload data
  if (!mc.id) {
    const orig = $('Route by Event Type').item.json.body.original_body || {};
    const statusMap = { subscribe: "Subscribed", unsubscribe: "Unsubscribed", profile: "Subscribed" };
    results.push({
      json: {
        email: $('Route by Event Type').item.json.body.email,
        email_marketing: statusMap[eventType] || "Subscribed",
        tags: [],
      },
    });
    continue;
  }

  // Build profile URL from web_id
  const profileUrl = mc.web_id
    ? "https://" + MC_DC + ".admin.mailchimp.com/lists/members/view?id=" + mc.web_id
    : null;

  // Map Mailchimp status to our status
  const statusMap = {
    subscribed: "Subscribed",
    unsubscribed: "Unsubscribed",
    cleaned: "Cleaned",
    pending: "Subscribed",
    transactional: "Subscribed",
  };

  // Extract tags
  const tags = (mc.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean);

  // Extract merge fields
  const mf = mc.merge_fields || {};

  // Parse address if present
  const addr = mf.ADDRESS || {};
  const hasAddress = typeof addr === 'object' && addr.addr1;

  results.push({
    json: {
      email: mc.email_address,
      first_name: mf.FNAME || null,
      last_name: mf.LNAME || null,
      company: mf.COMPANY || null,
      phone: mf.PHONE || null,
      street_address: hasAddress ? addr.addr1 : null,
      street_address_2: hasAddress ? (addr.addr2 || null) : null,
      city: hasAddress ? (addr.city || null) : null,
      state: hasAddress ? (addr.state || null) : null,
      postal_code: hasAddress ? (addr.zip || null) : null,
      country: hasAddress ? (addr.country || null) : null,
      email_marketing: statusMap[mc.status] || "Subscribed",
      tags: tags,
      mailchimp_profile: profileUrl,
    },
  });
}

return results;`,
  },
  { position: [1000, 0], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Non-fetchable events: upemail + cleaned
// These use the original payload data since we can't reliably fetch fresh state.
// ---------------------------------------------------------------------------

// 6a. Map upemail event — creates two items (new email + old email)
const mapUpemail = createNode(
  'Map Upemail',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const items = $input.all();
const results = [];

for (const item of items) {
  const orig = item.json.body.original_body || {};
  results.push({
    json: {
      email: orig["data[new_email]"] || "",
      email_marketing: "Subscribed",
      tags: [],
    },
  });
  results.push({
    json: {
      email: orig["data[old_email]"] || "",
      email_marketing: "Unsubscribed",
      tags: [],
    },
  });
}

return results;`,
  },
  { position: [750, -200], typeVersion: 2 },
);

// 6b. Map cleaned event
const mapCleaned = createNode(
  'Map Cleaned',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const MC_DC = "${MAILCHIMP_DC}";

const items = $input.all();
const results = [];

for (const item of items) {
  const orig = item.json.body.original_body || {};
  const webId = orig["data[web_id]"] || "";
  const profileUrl = webId
    ? "https://" + MC_DC + ".admin.mailchimp.com/lists/members/view?id=" + webId
    : null;

  results.push({
    json: {
      email: item.json.body.email || orig["data[email]"] || "",
      email_marketing: "Cleaned",
      tags: [],
      mailchimp_profile: profileUrl,
    },
  });
}

return results;`,
  },
  { position: [750, -400], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Shared: Has Email? → Upsert → Respond 200
// ---------------------------------------------------------------------------

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
  { position: [1250, 0], typeVersion: 2.2 },
);

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
  { position: [1450, 0], typeVersion: 1.2 },
);

const respondOk = createNode(
  'Respond 200',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [1650, 0], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Mailchimp Audience Processor', {
  nodes: [
    webhook, verifySignature, respond401,
    routeByType,
    // Fetchable path
    fetchSubscriber, mapFreshData,
    // Non-fetchable paths
    mapUpemail, mapCleaned,
    // Shared tail
    hasEmail, upsertContact, respondOk,
  ],
  connections: [
    connect(webhook, verifySignature),
    connect(verifySignature, routeByType, 0),       // success → route
    connect(verifySignature, respond401, 1),         // error → 401

    // Route outputs: 0=upemail, 1=cleaned, 2=fallback (fetchable)
    connect(routeByType, mapUpemail, 0),
    connect(routeByType, mapCleaned, 1),
    connect(routeByType, fetchSubscriber, 2),

    // Fetchable path
    connect(fetchSubscriber, mapFreshData),

    // All three paths converge at Has Email?
    connect(mapFreshData, hasEmail),
    connect(mapUpemail, hasEmail),
    connect(mapCleaned, hasEmail),

    // Shared tail
    connect(hasEmail, upsertContact),
    connect(upsertContact, respondOk),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
