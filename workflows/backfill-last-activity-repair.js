/**
 * Backfill Last Activity Repair
 *
 * Remediation for the relink-backfill cascade incident: while patching Activity
 * records, each change fired the Notion router → activity-webhook, which wrote
 * each activity's (often stale) date onto its related contacts' and deals'
 * "Last Activity" property — overwriting their real, newer values.
 *
 * This workflow recomputes the CORRECT Last Activity for every contact and deal
 * as the maximum date across all Activity records related to it, and patches
 * only where the stored value differs. Idempotent + batched.
 *
 * MUST be run with maintenance mode ON — patching a contact otherwise cascades
 * through the router to the Mailchimp sync. The patches themselves go straight
 * to the Notion API, so maintenance mode does not block them.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8';
const CONTACTS_DB_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';
const SALES_DB_ID = '2ed21e43d3a545f48cf4a2a8f61a264f';
const PARTNER_DB_ID = '457cfa4c123b4718a7d3c8bf7ea4a27e';
const COMMS_DB_ID = '35d10c8392e64ce2adc28c03e2c97480';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const BATCH_LIMIT = 25;

// ---------------------------------------------------------------------------
// Code: recompute correct Last Activity per contact/deal, emit patches
// ---------------------------------------------------------------------------
const BUILD_REPAIR_CODE = `
function relArray(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function toStart(v) { return (v && typeof v === 'object') ? v.start : v; }
function tsOf(v) { const s = toStart(v); if (!s) return null; const t = new Date(s).getTime(); return isNaN(t) ? null : t; }

// --- max activity date per related page (contact or deal) ---
const maxDate = new Map();  // pageId -> { ts, start }
function consider(pageId, start) {
  const t = new Date(start).getTime();
  if (isNaN(t)) return;
  const cur = maxDate.get(pageId);
  if (!cur || t > cur.ts) maxDate.set(pageId, { ts: t, start });
}
for (const it of $('Get All Activities').all()) {
  const j = it.json;
  const start = toStart(j.property_date);
  if (!start) continue;
  for (const cid of relArray(j.property_contact)) consider(cid, start);
  for (const did of [
    ...relArray(j.property_sales_pipeline),
    ...relArray(j.property_partner_pipeline),
    ...relArray(j.property_comms_pipeline),
  ]) consider(did, start);
}

// --- compare against stored Last Activity; patch where different ---
const patches = [];
function checkPage(pageId, currentLA) {
  const want = maxDate.get(pageId);
  if (!want) return;                       // page has no related activities → leave as-is
  if (tsOf(currentLA) === want.ts) return; // already correct
  patches.push({
    json: {
      pageId,
      patchBody: JSON.stringify({ properties: { 'Last Activity': { date: { start: want.start } } } }),
      current: toStart(currentLA) || null,
      correct: want.start,
    },
  });
}
for (const it of $('Get All Contacts').all()) checkPage(it.json.id, it.json.property_last_activity);
for (const src of ['Get All Sales', 'Get All Partner', 'Get All Comms']) {
  for (const it of $(src).all()) checkPage(it.json.id, it.json.property_last_activity);
}

if (patches.length === 0) return [{ json: { _empty: true } }];
return patches.slice(0, ${BATCH_LIMIT});
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Run Repair',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 300] },
);

const webhookTrigger = createNode(
  'Run via Webhook',
  'n8n-nodes-base.webhook',
  { httpMethod: 'POST', path: 'backfill-last-activity-repair-run', responseMode: 'onReceived', options: {} },
  { position: [0, 500], typeVersion: 2 },
);
webhookTrigger.webhookId = 'backfill-last-activity-repair-run';

function getAllNode(name, dbId, x, executeOnce) {
  const node = createNode(
    name,
    'n8n-nodes-base.notion',
    {
      resource: 'databasePage',
      operation: 'getAll',
      databaseId: { __rl: true, mode: 'id', value: dbId },
      returnAll: true,
      options: {},
    },
    { position: [x, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
  );
  node.retryOnFail = true;
  node.maxTries = 3;
  node.waitBetweenTries = 1000;
  if (executeOnce) node.executeOnce = true;
  return node;
}

const getActivities = getAllNode('Get All Activities', ACTIVITIES_DB_ID, 220, false);
const getContacts = getAllNode('Get All Contacts', CONTACTS_DB_ID, 440, true);
const getSales = getAllNode('Get All Sales', SALES_DB_ID, 660, true);
const getPartner = getAllNode('Get All Partner', PARTNER_DB_ID, 880, true);
const getComms = getAllNode('Get All Comms', COMMS_DB_ID, 1100, true);

const buildRepair = createNode(
  'Build Repair Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_REPAIR_CODE },
  { position: [1320, 300], typeVersion: 2 },
);

const hasPatches = createNode(
  'Has Patches?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'empty-check',
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1540, 300], typeVersion: 2 },
);

const processBatches = createNode(
  'Process One at a Time',
  'n8n-nodes-base.splitInBatches',
  { batchSize: 1, options: {} },
  { position: [1760, 300], typeVersion: 3 },
);

const patchPage = createNode(
  'Patch Last Activity',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.pageId }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.patchBody }}',
    options: {},
  },
  { position: [1980, 300], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
patchPage.retryOnFail = true;
patchPage.maxTries = 3;
patchPage.waitBetweenTries = 1000;
patchPage.continueOnFail = true;

const wait = createNode(
  'Wait 400ms',
  'n8n-nodes-base.wait',
  { amount: 0.4 },
  { position: [2200, 300], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Backfill Last Activity Repair', {
  nodes: [
    trigger,
    webhookTrigger,
    getActivities,
    getContacts,
    getSales,
    getPartner,
    getComms,
    buildRepair,
    hasPatches,
    processBatches,
    patchPage,
    wait,
  ],
  connections: [
    connect(trigger, getActivities),
    connect(webhookTrigger, getActivities),
    connect(getActivities, getContacts),
    connect(getContacts, getSales),
    connect(getSales, getPartner),
    connect(getPartner, getComms),
    connect(getComms, buildRepair),
    connect(buildRepair, hasPatches),
    connect(hasPatches, processBatches, 0),
    connect(processBatches, patchPage, 1, 0),
    connect(patchPage, wait),
    connect(wait, processBatches),
  ],
  settings: {
    executionOrder: 'v1',
  },
});
