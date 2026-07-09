/**
 * Backfill Activity Relink + Rename
 *
 * One-time workflow to retrofit existing email Activity records to match the
 * current Email Graph Webhook behavior:
 *   1. RENAME to the compact format: {↑ sent | ↓ received} Email
 *      MM-DD-YYYY HH:MM (US Central) · {full subject}. The full subject is
 *      recovered from the Subject property (the old Name truncated it to 3 words).
 *   2. RE-LINK pipeline relations: link every deal the activity's Contact(s) are
 *      related to, EXCEPT genuinely dead ones (Lost/rejected, Rejected/Cancelled).
 *      Existing links are preserved (union), so any manual curation survives.
 *
 * Only email activities (Direction = Sent/Received) are touched. Notes/outcomes
 * keep their own names and links. Idempotent — records already correct are
 * skipped, so it is safe to re-run.
 *
 * Strategy: fetch Activities + Contacts + all three pipeline DBs in one pass
 * each (executeOnce), compute every patch in a single Code node, then PATCH one
 * record at a time with a small delay for Notion rate limits.
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

// Max records patched per fire. The workflow is idempotent (already-correct
// records are skipped), so firing it repeatedly walks through the backlog in
// controlled chunks with a verify checkpoint between each.
const BATCH_LIMIT = 25;

// ---------------------------------------------------------------------------
// Code: compute rename + relink patches for every email activity
// ---------------------------------------------------------------------------
const BUILD_PATCHES_CODE = `
// Dead statuses that should NOT be linked (mirrors email-graph-webhook.js).
const EXCLUDED = { sales: ['Lost/rejected'], partner: ['Lost/rejected'], comms: ['Rejected/Cancelled'] };
const REL_PROP = { sales: 'Sales pipeline', partner: 'Partner pipeline', comms: 'Comms pipeline' };

// --- name helpers (identical to the live workflow) ---
function formatEmailDatetime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return p.month + '-' + p.day + '-' + p.year + ' ' + p.hour + ':' + p.minute;   // MM-DD-YYYY HH:MM (US Central)
}
function cleanSubject(subject) {
  return (subject || '').replace(/^(Re|Fwd?|FW|AW|TR):\\s*/i, '').trim() || '(no subject)';
}
function relArray(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

// --- dealId -> { type, status } from the three pipeline DBs ---
const dealStatus = new Map();
for (const it of $('Get All Sales').all())   dealStatus.set(it.json.id, { type: 'sales',   status: it.json.property_status || '' });
for (const it of $('Get All Partner').all()) dealStatus.set(it.json.id, { type: 'partner', status: it.json.property_status || '' });
for (const it of $('Get All Comms').all())   dealStatus.set(it.json.id, { type: 'comms',   status: it.json.property_status || '' });

// --- contactId -> { sales:[], partner:[], comms:[] } relation arrays ---
const contactPipes = new Map();
for (const it of $('Get All Contacts').all()) {
  const j = it.json;
  contactPipes.set(j.id, {
    sales:   relArray(j.property_sales_pipeline),
    partner: relArray(j.property_partner_pipeline),
    comms:   relArray(j.property_comms_pipeline),
  });
}

const patches = [];
for (const it of $('Get All Activities').all()) {
  const a = it.json;
  const dir = a.property_direction;
  if (dir !== 'Sent' && dir !== 'Received') continue;  // email activities only

  // --- new name ---
  const arrow = dir === 'Sent' ? '↑' : '↓';
  const rawDate = a.property_date;
  const dateStart = (rawDate && typeof rawDate === 'object' ? rawDate.start : rawDate) || '';
  const newName = (arrow + ' Email ' + formatEmailDatetime(dateStart) + ' · ' + cleanSubject(a.property_subject)).substring(0, 120);

  // --- desired links: union of each linked contact's non-dead deals ---
  const desired = { sales: new Set(), partner: new Set(), comms: new Set() };
  for (const cid of relArray(a.property_contact)) {
    const pipes = contactPipes.get(cid);
    if (!pipes) continue;
    for (const type of ['sales', 'partner', 'comms']) {
      for (const dealId of pipes[type]) {
        const info = dealStatus.get(dealId);
        if (info && EXCLUDED[type].includes(info.status)) continue;  // dead → skip
        desired[type].add(dealId);
      }
    }
  }

  // --- preserve any existing links (manual curation) by unioning them in ---
  const existing = {
    sales:   relArray(a.property_sales_pipeline),
    partner: relArray(a.property_partner_pipeline),
    comms:   relArray(a.property_comms_pipeline),
  };
  for (const type of ['sales', 'partner', 'comms']) {
    for (const id of existing[type]) desired[type].add(id);
  }

  // --- assemble props, including only what actually changed ---
  const props = {};
  let changed = false;

  const oldName = a.property_name || a.name || '';
  if (newName !== oldName) { props['Name'] = { title: [{ text: { content: newName } }] }; changed = true; }

  for (const type of ['sales', 'partner', 'comms']) {
    const want = Array.from(desired[type]).sort();
    const have = existing[type].slice().sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      props[REL_PROP[type]] = { relation: want.map(id => ({ id })) };
      changed = true;
    }
  }

  if (!changed) continue;
  patches.push({ json: { pageId: a.id, patchBody: JSON.stringify({ properties: props }), oldName, newName } });
}

if (patches.length === 0) return [{ json: { _empty: true } }];
return patches.slice(0, ${BATCH_LIMIT});
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Run Backfill',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 300] },
);

// Webhook trigger so the backfill can be fired via API (the public API cannot
// trigger manual-trigger workflows). responseMode 'onReceived' acks immediately
// and the loop runs in the background. Both triggers feed Get All Activities.
const webhookTrigger = createNode(
  'Run via Webhook',
  'n8n-nodes-base.webhook',
  { httpMethod: 'POST', path: 'backfill-activity-relink-run', responseMode: 'onReceived', options: {} },
  { position: [0, 500], typeVersion: 2 },
);
webhookTrigger.webhookId = 'backfill-activity-relink-run';

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

// First fetch runs once off the trigger; the rest use executeOnce so they run a
// single time regardless of how many items the previous fetch emitted.
const getActivities = getAllNode('Get All Activities', ACTIVITIES_DB_ID, 220, false);
const getContacts = getAllNode('Get All Contacts', CONTACTS_DB_ID, 440, true);
const getSales = getAllNode('Get All Sales', SALES_DB_ID, 660, true);
const getPartner = getAllNode('Get All Partner', PARTNER_DB_ID, 880, true);
const getComms = getAllNode('Get All Comms', COMMS_DB_ID, 1100, true);

const buildPatches = createNode(
  'Build Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_PATCHES_CODE },
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

const patchActivity = createNode(
  'Patch Activity',
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
patchActivity.retryOnFail = true;
patchActivity.maxTries = 3;
patchActivity.waitBetweenTries = 1000;
patchActivity.continueOnFail = true;

const wait = createNode(
  'Wait 400ms',
  'n8n-nodes-base.wait',
  { amount: 0.4 },
  { position: [2200, 300], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Backfill Activity Relink', {
  nodes: [
    trigger,
    webhookTrigger,
    getActivities,
    getContacts,
    getSales,
    getPartner,
    getComms,
    buildPatches,
    hasPatches,
    processBatches,
    patchActivity,
    wait,
  ],
  connections: [
    connect(trigger, getActivities),
    connect(webhookTrigger, getActivities),
    connect(getActivities, getContacts),
    connect(getContacts, getSales),
    connect(getSales, getPartner),
    connect(getPartner, getComms),
    connect(getComms, buildPatches),
    connect(buildPatches, hasPatches),
    connect(hasPatches, processBatches, 0),      // output 0 (true): has patches
    connect(processBatches, patchActivity, 1, 0),  // output 1: loop item
    connect(patchActivity, wait),
    connect(wait, processBatches),                 // loop back
  ],
  settings: {
    executionOrder: 'v1',
  },
});
