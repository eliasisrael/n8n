/**
 * Activity Webhook
 *
 * Sub-workflow called by adapter-activities when an Activity record is
 * created or updated in Notion. Updates "Last Activity" (date-time) on
 * all related contacts and pipeline deals.
 *
 * Expects the standard { body, record } payload from the adapter.
 * Uses the activity's Date value (not today), since users may log past interactions.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Code: Parse activity record and build PATCH bodies
// ---------------------------------------------------------------------------
const PARSE_AND_BUILD_CODE = `
const record = $json.record;
if (!record) {
  return { json: { contactPatches: [], dealPatches: [] } };
}

// Get the activity date — use it as the "Last Activity" value
const rawDate = record.property_date;
const activityDate = (rawDate && typeof rawDate === 'object' ? rawDate.start : rawDate) || new Date().toISOString();

// Collect related contact page IDs
const contactIds = record.property_contact || [];

// Collect related deal page IDs from all three pipelines
const salesIds = record.property_sales_pipeline || [];
const partnerIds = record.property_partner_pipeline || [];
const commsIds = record.property_comms_pipeline || [];
const dealIds = [...salesIds, ...partnerIds, ...commsIds];

// Build PATCH bodies
const patchBody = JSON.stringify({
  properties: {
    'Last Activity': { date: { start: activityDate } },
  },
});

const contactPatches = contactIds.map(id => ({
  pageId: id,
  patchBody,
}));

const dealPatches = dealIds.map(id => ({
  pageId: id,
  patchBody,
}));

return {
  json: {
    contactPatches,
    dealPatches,
  },
};
`;

// ---------------------------------------------------------------------------
// Code: Expand contact patches into individual items
// ---------------------------------------------------------------------------
const EXPAND_CONTACTS_CODE = `
const patches = $json.contactPatches || [];
if (patches.length === 0) {
  return [{ json: { _empty: true } }];
}
return patches.map(p => ({ json: p }));
`;

// ---------------------------------------------------------------------------
// Code: Expand deal patches into individual items
// ---------------------------------------------------------------------------
const EXPAND_DEALS_CODE = `
const patches = $json.dealPatches || [];
if (patches.length === 0) {
  return [{ json: { _empty: true } }];
}
return patches.map(p => ({ json: p }));
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Execute Workflow Trigger
const trigger = createNode(
  'Execute Workflow Trigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { position: [0, 300], typeVersion: 1.1 },
);

// 2. Parse & Build Patches
const parseAndBuild = createNode(
  'Parse & Build Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForEachItem', jsCode: PARSE_AND_BUILD_CODE },
  { position: [250, 300], typeVersion: 2 },
);

// 3a. Expand Contact Patches
const expandContacts = createNode(
  'Expand Contact Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: EXPAND_CONTACTS_CODE },
  { position: [500, 200], typeVersion: 2 },
);

// 3b. Expand Deal Patches
const expandDeals = createNode(
  'Expand Deal Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: EXPAND_DEALS_CODE },
  { position: [500, 400], typeVersion: 2 },
);

// 4a. Has Contacts? (IF)
const hasContacts = createNode(
  'Has Contacts?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'contact-check',
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [750, 200], typeVersion: 2 },
);

// 4b. Has Deals? (IF)
const hasDeals = createNode(
  'Has Deals?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'deal-check',
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [750, 400], typeVersion: 2 },
);

// 5a. Update Contact Last Activity (HTTP PATCH)
const updateContact = createNode(
  'Update Contact Last Activity',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.pageId }}',
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
    jsonBody: '={{ $json.patchBody }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [1000, 200], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
updateContact.retryOnFail = true;
updateContact.continueOnFail = true;

// 5b. Update Deal Last Activity (HTTP PATCH)
const updateDeal = createNode(
  'Update Deal Last Activity',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.pageId }}',
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
    jsonBody: '={{ $json.patchBody }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [1000, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
updateDeal.retryOnFail = true;
updateDeal.continueOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Activity Webhook', {
  nodes: [
    trigger,
    parseAndBuild,
    expandContacts,
    expandDeals,
    hasContacts,
    hasDeals,
    updateContact,
    updateDeal,
  ],
  connections: [
    connect(trigger, parseAndBuild),
    connect(parseAndBuild, expandContacts),
    connect(parseAndBuild, expandDeals),
    connect(expandContacts, hasContacts),
    connect(expandDeals, hasDeals),
    connect(hasContacts, updateContact, 0),   // true branch
    connect(hasDeals, updateDeal, 0),          // true branch
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
