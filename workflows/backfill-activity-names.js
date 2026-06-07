/**
 * Backfill Activity Names
 *
 * One-time workflow to rename existing Notion Activity records that use the
 * old non-unique naming convention. Applies the new pattern:
 *   [Type] · [YYYY-MM-DD HH:MM] · [key detail]   (emails)
 *   [Type] · [YYYY-MM-DD] · [key detail]           (notes, outcomes)
 *
 * Skips records whose name already contains ' · ' (already updated).
 *
 * Run manually from the n8n UI after building and pushing.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Code: inspect each activity and build a PATCH body for records that need
// renaming. Returns patch items or a sentinel if nothing needs updating.
// ---------------------------------------------------------------------------
const FILTER_AND_BUILD_CODE = `
function formatDate(isoStr) {
  return (isoStr || '').slice(0, 10);
}

function formatDatetime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const date = d.toISOString().slice(0, 10);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return date + ' ' + hh + ':' + mm;
}

function stripReplyPrefix(subject) {
  return (subject || '').replace(/^(Re|Fwd?|FW|AW|TR):\\s*/i, '').trim();
}

function firstWords(str, n) {
  return (str || '').split(/\\s+/).filter(Boolean).slice(0, n).join(' ');
}

const patches = [];

for (const item of $input.all()) {
  const r = item.json;
  const pageId = r.id;
  const currentName = r.name || '';

  // Already in new format — skip
  if (currentName.includes(' · ')) continue;

  const activityType = r.property_type || '';
  const direction = r.property_direction || '';
  const rawDate = r.property_date;
  const dateStart = (rawDate && typeof rawDate === 'object' ? rawDate.start : rawDate) || '';
  const subject = r.property_subject || '';

  let newName = '';

  if (direction) {
    // Email activity: include time since there can be many per day
    const emailType = direction === 'Sent' ? 'Email Sent' : 'Email Received';
    const dateStr = formatDatetime(dateStart);
    const keyDetail = firstWords(stripReplyPrefix(subject) || currentName, 3) || '(no subject)';
    newName = (emailType + ' · ' + dateStr + ' · ' + keyDetail).substring(0, 100);
  } else if (activityType === 'Account Note') {
    const dateStr = formatDate(dateStart);
    const keyDetail = firstWords(currentName, 3) || 'note';
    newName = ('Account Note · ' + dateStr + ' · ' + keyDetail).substring(0, 100);
  } else if (activityType) {
    // Outcome or other typed activity (Deal Won, Deal Lost, etc.)
    const dateStr = formatDate(dateStart);
    // Strip old "Type: DealName" format to extract the key detail
    const prefix = activityType + ': ';
    const dealName = currentName.startsWith(prefix) ? currentName.slice(prefix.length) : currentName;
    const keyDetail = firstWords(dealName, 3) || 'activity';
    newName = (activityType + ' · ' + dateStr + ' · ' + keyDetail).substring(0, 100);
  } else {
    continue; // Unknown type — skip
  }

  if (newName && newName !== currentName) {
    patches.push({ json: { pageId, newName, oldName: currentName } });
  }
}

if (patches.length === 0) {
  return [{ json: { _empty: true } }];
}

return patches;
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Run Backfill',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 0] },
);

const getAllActivities = createNode(
  'Get All Activities',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: ACTIVITIES_DB_ID },
    returnAll: true,
    options: {},
  },
  { position: [224, 0], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getAllActivities.retryOnFail = true;
getAllActivities.maxTries = 3;
getAllActivities.waitBetweenTries = 1000;

const filterAndBuild = createNode(
  'Filter & Build Patches',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: FILTER_AND_BUILD_CODE },
  { position: [448, 0], typeVersion: 2 },
);

// Has items that need updating? (_empty sentinel → skip; real patches → process)
const hasUpdates = createNode(
  'Has Updates?',
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
  { position: [672, 0], typeVersion: 2 },
);

const processBatches = createNode(
  'Process One at a Time',
  'n8n-nodes-base.splitInBatches',
  { batchSize: 1, options: {} },
  { position: [896, 0], typeVersion: 3 },
);

const patchName = createNode(
  'Patch Activity Name',
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
    jsonBody: '={{ JSON.stringify({ properties: { Name: { title: [{ text: { content: $json.newName } }] } } }) }}',
    options: {},
  },
  { position: [1120, 0], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
patchName.retryOnFail = true;
patchName.maxTries = 3;
patchName.waitBetweenTries = 1000;
patchName.continueOnFail = true;

const wait = createNode(
  'Wait 400ms',
  'n8n-nodes-base.wait',
  { amount: 0.4 },
  { position: [1344, 0], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Backfill Activity Names', {
  nodes: [
    trigger,
    getAllActivities,
    filterAndBuild,
    hasUpdates,
    processBatches,
    patchName,
    wait,
  ],
  connections: [
    connect(trigger, getAllActivities),
    connect(getAllActivities, filterAndBuild),
    connect(filterAndBuild, hasUpdates),
    connect(hasUpdates, processBatches, 0),      // output 0 (true): has patches → batch
    // output 1 (false): _empty sentinel → nothing connected, execution ends
    connect(processBatches, patchName, 1, 0),    // loop output → patch
    connect(patchName, wait),
    connect(wait, processBatches),               // loop back
  ],
  settings: {
    executionOrder: 'v1',
  },
});
