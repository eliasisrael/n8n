/**
 * Find & Import Orphaned Mailchimp Members
 *
 * One-time workflow that identifies Mailchimp audience members with no
 * matching contact in the Notion master contacts database, then creates
 * Notion contacts for each orphan via the upsert sub-workflow.
 *
 * After creation, PATCHes Mailchimp to set the NOTIONID merge field
 * linking the subscriber to the new Notion page.
 *
 * Flow:
 *   Manual Trigger → Get All Mailchimp Members (paginated)
 *   → Get All Notion Contacts → Find Orphans (Code)
 *   → SplitInBatches(1) → Upsert to Notion → PATCH NOTIONID to Mailchimp
 *   → Wait 400ms → Loop
 *
 * Run with maintenance mode ON to prevent webhook cascades.
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
const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };
const MAILCHIMP_CREDENTIAL = { mailchimpOAuth2Api: { id: 'DtyHZOOulvefkbC3', name: 'Mailchimp account' } };

// ---------------------------------------------------------------------------
// Phase 1: Detection — bulk fetch both sides, compare in memory
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Run Audit',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 0] },
);

const getMailchimpMembers = createNode(
  'Get All Mailchimp Members',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: `=https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${LIST_ID}/members`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'count', value: '1000' },
      ],
    },
    options: {
      pagination: {
        pagination: {
          paginationMode: 'updateAParameterInEachRequest',
          parameters: {
            parameters: [
              {
                name: 'offset',
                type: 'queryString',
                value: '={{ $request.queryString.offset !== undefined ? Number($request.queryString.offset) + 1000 : 1000 }}',
              },
            ],
          },
          paginationCompleteWhen: 'other',
          completeExpression: '={{ $response.body.members.length < 1000 }}',
          limitPagesFetched: true,
          maxRequests: 50,
          requestInterval: 500,
        },
      },
    },
  },
  { position: [224, 0], typeVersion: 4.2, credentials: MAILCHIMP_CREDENTIAL },
);

const getNotionContacts = createNode(
  'Get All Notion Contacts',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: DATABASE_ID },
    returnAll: true,
    options: {},
  },
  { position: [448, 0], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);

// Map Mailchimp status → Notion Email Marketing select value
const STATUS_MAP = {
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
  cleaned: 'Cleaned',
  pending: 'Subscribed',
  transactional: 'Subscribed',
};

const findOrphans = createNode(
  'Find Orphans',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const crypto = require('crypto');

// Build Set of all Notion contact emails
const notionItems = $('Get All Notion Contacts').all();
const notionEmails = new Set();
for (const item of notionItems) {
  const email = (item.json.property_email || item.json.property_identifier || '')
    .toString().trim().toLowerCase();
  if (email && email.includes('@')) notionEmails.add(email);
}

// Flatten paginated Mailchimp responses — each page item has a .members array
const mcItems = $('Get All Mailchimp Members').all();
const allMembers = [];
for (const item of mcItems) {
  if (item.json.members && Array.isArray(item.json.members)) {
    allMembers.push(...item.json.members);
  } else if (item.json.email_address) {
    allMembers.push(item.json);
  }
}

const statusMap = ${JSON.stringify(STATUS_MAP)};

// Find Mailchimp members with no matching Notion contact
const orphans = [];
for (const m of allMembers) {
  const email = (m.email_address || '').toLowerCase().trim();
  if (!email) continue;
  if (!notionEmails.has(email)) {
    const mf = m.merge_fields || {};
    orphans.push({
      json: {
        // Fields for upsert sub-workflow
        email,
        first_name: mf.FNAME || '',
        last_name: mf.LNAME || '',
        company: mf.COMPANY || '',
        phone: mf.PHONE || '',
        email_marketing: statusMap[m.status] || 'Subscribed',
        mailchimp_profile: m.web_id
          ? 'https://${MAILCHIMP_DC}.admin.mailchimp.com/lists/members/view?id=' + m.web_id
          : '',
        // Fields for NOTIONID PATCH
        emailMd5: crypto.createHash('md5').update(email).digest('hex'),
        web_id: m.web_id,
        mc_status: m.status,
      },
    });
  }
}

return orphans.length > 0
  ? orphans
  : [{ json: {
      message: 'No orphans found',
      notion_contact_count: notionEmails.size,
      mailchimp_member_count: allMembers.length,
    } }];`,
  },
  { position: [672, 0], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Phase 2: Insert orphans into Notion and claim NOTIONID in Mailchimp
// ---------------------------------------------------------------------------

const splitBatches = createNode(
  'Process One at a Time',
  'n8n-nodes-base.splitInBatches',
  { batchSize: 1, options: {} },
  { position: [896, 0], typeVersion: 3 },
);

// Call the existing upsert sub-workflow to create the Notion contact.
// The upsert handles: check if exists → create/update with proper property mapping.
// It returns the Notion page data including the page ID.
const upsertToNotion = createNode(
  'Upsert to Notion',
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
        email: '={{ $json.email }}',
        first_name: '={{ $json.first_name }}',
        last_name: '={{ $json.last_name }}',
        company: '={{ $json.company }}',
        phone: '={{ $json.phone }}',
        email_marketing: '={{ $json.email_marketing }}',
        mailchimp_profile: '={{ $json.mailchimp_profile }}',
      },
      matchingColumns: [],
      schema: [
        { id: 'email', displayName: 'email', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'first_name', displayName: 'first_name', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'last_name', displayName: 'last_name', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'company', displayName: 'company', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'email_marketing', displayName: 'email_marketing', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'mailchimp_profile', displayName: 'mailchimp_profile', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {
      waitForSubWorkflow: true,
    },
  },
  { position: [1120, 0], typeVersion: 1.2 },
);

// The upsert sub-workflow returns the Notion API response which includes
// the page ID. Extract it and PATCH Mailchimp to set NOTIONID.
const patchNotionId = createNode(
  'Set NOTIONID in Mailchimp',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: `=https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${LIST_ID}/members/{{ $('Process One at a Time').item.json.emailMd5 }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ merge_fields: { NOTIONID: $json.id } }) }}',
    options: {},
  },
  { position: [1344, 0], typeVersion: 4.2, credentials: MAILCHIMP_CREDENTIAL },
);
patchNotionId.onError = 'continueRegularOutput';

const wait = createNode(
  'Wait 400ms',
  'n8n-nodes-base.wait',
  { amount: 0.4 },
  { position: [1568, 0], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Find & Import Orphaned Mailchimp Members', {
  nodes: [
    trigger, getMailchimpMembers, getNotionContacts, findOrphans,
    splitBatches, upsertToNotion, patchNotionId, wait,
  ],
  connections: [
    // Phase 1: detection
    connect(trigger, getMailchimpMembers),
    connect(getMailchimpMembers, getNotionContacts),
    connect(getNotionContacts, findOrphans),

    // Phase 2: insertion loop
    connect(findOrphans, splitBatches),
    connect(splitBatches, upsertToNotion, 1, 0),    // Loop output → process
    connect(upsertToNotion, patchNotionId),           // upsert returns page with .id
    connect(patchNotionId, wait),
    connect(wait, splitBatches),                      // loop back
  ],
  settings: {
    executionOrder: 'v1',
  },
});
