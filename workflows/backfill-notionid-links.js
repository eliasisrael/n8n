/**
 * Backfill NOTIONID Links
 *
 * One-time workflow to sync NOTIONID merge fields in Mailchimp and
 * Mailchimp Profile URLs in Notion for all existing contacts.
 *
 * For each Notion contact with an email:
 *   - If Mailchimp subscriber exists + NOTIONID blank → PATCH NOTIONID
 *   - If Notion Mailchimp Profile blank → PATCH URL to Notion
 *   - If NOT in Mailchimp → CREATE subscriber (respecting email_marketing
 *     status) with NOTIONID claimed, then write URL to Notion
 *
 * Run manually AFTER deactivating the Notion Webhook Router and
 * Mailchimp Audience Hook to avoid cascading webhook events.
 *
 * Flow:
 *   Manual Trigger → Get All Notion Contacts → Prepare Records (Code)
 *   → SplitInBatches(1) → GET Mailchimp Subscriber → Decide Actions (Code)
 *   → IF Create?
 *     ├─ True:  PUT Mailchimp → Build URL (Create) → Write URL to Notion (Create) → Wait → Loop
 *     └─ False: IF NOTIONID blank? → PATCH NOTIONID
 *               → IF Notion URL blank? → PATCH URL to Notion → Wait → Loop
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';
import loadEnv from '../lib/load-env.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = loadEnv({ required: true });
const MAILCHIMP_DC = env.MAILCHIMP_DC;
const LIST_ID = '77d135987f';
const DATABASE_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };
const MAILCHIMP_CREDENTIAL = { mailchimpOAuth2Api: { id: 'DtyHZOOulvefkbC3', name: 'Mailchimp account' } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boolCondition(expr) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: expr,
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Run Backfill',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 0] },
);

const getAllContacts = createNode(
  'Get All Contacts',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: DATABASE_ID },
    returnAll: true,
    options: {},
  },
  { position: [200, 0], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);

const prepare = createNode(
  'Prepare Records',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const crypto = require('crypto');
const results = [];

for (const item of $input.all()) {
  const d = item.json;
  const email = (d.property_email || d.property_identifier || '').toLowerCase().trim();
  if (!email) continue;

  const pageId = d.id;
  const mailchimpProfile = d.property_mailchimp_profile || null;
  const md5 = crypto.createHash('md5').update(email).digest('hex');

  results.push({
    json: {
      email,
      notionPageId: pageId,
      emailMd5: md5,
      hasMailchimpProfile: !!mailchimpProfile,
      // Fields for Mailchimp create (if subscriber doesn't exist)
      firstName: d.property_first_name || '',
      lastName: d.property_last_name || '',
      company: d.property_company_name || '',
      phone: d.property_phone || '',
      address: d.property_street_address || '',
      emailMarketing: d.property_email_marketing || 'subscribed',
    },
  });
}

return results;`,
  },
  { position: [400, 0], typeVersion: 2 },
);

const splitBatches = createNode(
  'Process One at a Time',
  'n8n-nodes-base.splitInBatches',
  {
    batchSize: 1,
    options: {},
  },
  { position: [600, 0], typeVersion: 3 },
);

const getSubscriber = createNode(
  'Get Mailchimp Subscriber',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: `=https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${LIST_ID}/members/{{ $json.emailMd5 }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    options: {},
  },
  { position: [800, 0], typeVersion: 4.2, credentials: MAILCHIMP_CREDENTIAL },
);
// Don't fail on 404 (contact not in Mailchimp)
getSubscriber.onError = 'continueRegularOutput';

const decide = createNode(
  'Decide Actions',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const prepared = $('Process One at a Time').item.json;
const mc = $json;

// 404 returns { status: 404 } or { status_code: 404 }
const isSubscriber = mc.id && !mc.status_code && mc.status !== 404;

let createMailchimp = false;
let patchMailchimp = false;
let patchNotion = false;
let mailchimpUrl = null;
let web_id = null;

if (isSubscriber) {
  const notionId = (mc.merge_fields && mc.merge_fields.NOTIONID) || '';
  web_id = mc.web_id;

  // Need to write NOTIONID?
  if (!notionId) {
    patchMailchimp = true;
  }

  // Need to write Mailchimp Profile URL to Notion?
  if (!prepared.hasMailchimpProfile && web_id) {
    patchNotion = true;
    mailchimpUrl = 'https://${MAILCHIMP_DC}.admin.mailchimp.com/lists/members/view?id=' + web_id;
  }
} else {
  // Not in Mailchimp — create subscriber and claim
  createMailchimp = true;
}

return {
  json: {
    ...prepared,
    createMailchimp,
    patchMailchimp,
    patchNotion,
    mailchimpUrl,
    web_id,
    isSubscriber,
  },
};`,
  },
  { position: [1000, 0], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Create path (contact not in Mailchimp)
// ---------------------------------------------------------------------------

const ifCreate = createNode(
  'Needs Create?',
  'n8n-nodes-base.if',
  boolCondition('={{ $json.createMailchimp }}'),
  { position: [1200, 0], typeVersion: 2 },
);

const createSubscriber = createNode(
  'Create Mailchimp Subscriber',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PUT',
    url: `=https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${LIST_ID}/members/{{ $('Decide Actions').item.json.emailMd5 }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  email_address: $('Decide Actions').item.json.email,
  status_if_new: $('Decide Actions').item.json.emailMarketing === 'Unsubscribed' ? 'unsubscribed' : 'subscribed',
  merge_fields: {
    FNAME: $('Decide Actions').item.json.firstName,
    LNAME: $('Decide Actions').item.json.lastName,
    COMPANY: $('Decide Actions').item.json.company,
    NOTIONID: $('Decide Actions').item.json.notionPageId
  }
}) }}`,
    options: {},
  },
  { position: [1400, -200], typeVersion: 4.2, credentials: MAILCHIMP_CREDENTIAL },
);
createSubscriber.onError = 'continueRegularOutput';

// Build the Mailchimp admin URL from the PUT response
const buildUrlCreate = createNode(
  'Build URL (Create)',
  'n8n-nodes-base.set',
  {
    mode: 'manual',
    duplicateItem: false,
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'notionPageId',
          value: "={{ $('Decide Actions').item.json.notionPageId }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'mailchimpUrl',
          value: `={{ 'https://${MAILCHIMP_DC}.admin.mailchimp.com/lists/members/view?id=' + $json.web_id }}`,
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [1600, -200], typeVersion: 3.4 },
);

const patchNotionCreate = createNode(
  'Write URL to Notion (Create)',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.notionPageId }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ properties: { "Mailchimp Profile": { url: $json.mailchimpUrl } } }) }}',
    options: {},
  },
  { position: [1800, -200], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
patchNotionCreate.onError = 'continueRegularOutput';

// ---------------------------------------------------------------------------
// Existing-subscriber path (NOTIONID + Notion URL patches)
// ---------------------------------------------------------------------------

const ifMailchimp = createNode(
  'Needs Mailchimp Update?',
  'n8n-nodes-base.if',
  boolCondition('={{ $json.patchMailchimp }}'),
  { position: [1400, 100], typeVersion: 2 },
);

const patchMailchimpNode = createNode(
  'Write NOTIONID to Mailchimp',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: `=https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${LIST_ID}/members/{{ $json.emailMd5 }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ merge_fields: { NOTIONID: $json.notionPageId } }) }}',
    options: {},
  },
  { position: [1600, 50], typeVersion: 4.2, credentials: MAILCHIMP_CREDENTIAL },
);
patchMailchimpNode.onError = 'continueRegularOutput';

const ifNotion = createNode(
  'Needs Notion Update?',
  'n8n-nodes-base.if',
  boolCondition("={{ $('Decide Actions').item.json.patchNotion }}"),
  { position: [1800, 100], typeVersion: 2 },
);

const patchNotionNode = createNode(
  'Write URL to Notion',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: "=https://api.notion.com/v1/pages/{{ $('Decide Actions').item.json.notionPageId }}",
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ properties: { "Mailchimp Profile": { url: $('Decide Actions').item.json.mailchimpUrl } } }) }}`,
    options: {},
  },
  { position: [2000, 50], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
patchNotionNode.onError = 'continueRegularOutput';

// ---------------------------------------------------------------------------
// Rate-limit and loop
// ---------------------------------------------------------------------------

const wait = createNode(
  'Wait 400ms',
  'n8n-nodes-base.wait',
  { amount: 0.4 },
  { position: [2200, 0], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Backfill NOTIONID Links', {
  nodes: [
    trigger, getAllContacts, prepare, splitBatches,
    getSubscriber, decide,
    // Create path
    ifCreate, createSubscriber, buildUrlCreate, patchNotionCreate,
    // Existing-subscriber path
    ifMailchimp, patchMailchimpNode, ifNotion, patchNotionNode,
    // Loop
    wait,
  ],
  connections: [
    // Main chain
    connect(trigger, getAllContacts),
    connect(getAllContacts, prepare),
    connect(prepare, splitBatches),
    connect(splitBatches, getSubscriber, 1, 0),         // Loop output → process
    connect(getSubscriber, decide),
    connect(decide, ifCreate),

    // Create path (true branch)
    connect(ifCreate, createSubscriber, 0, 0),           // true → create in MC
    connect(createSubscriber, buildUrlCreate),            // response has web_id
    connect(buildUrlCreate, patchNotionCreate),           // write URL to Notion
    connect(patchNotionCreate, wait),                     // → wait → loop

    // Existing-subscriber path (false branch)
    connect(ifCreate, ifMailchimp, 1, 0),                 // false → existing logic
    connect(ifMailchimp, patchMailchimpNode, 0, 0),       // true → patch NOTIONID
    connect(ifMailchimp, ifNotion, 1, 0),                 // false → skip to Notion check
    connect(patchMailchimpNode, ifNotion),                // after MC patch → Notion check
    connect(ifNotion, patchNotionNode, 0, 0),             // true → patch Notion URL
    connect(ifNotion, wait, 1, 0),                        // false → wait
    connect(patchNotionNode, wait),                       // after Notion patch → wait

    // Loop back
    connect(wait, splitBatches),
  ],
  settings: {
    executionOrder: 'v1',
  },
});
