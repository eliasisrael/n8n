/**
 * Stale Pipeline Alerts → VF Tasks with AI Suggested Next Step
 *
 * Daily workflow that scans the Sales, Superfriend, and Comms pipeline
 * databases for deals that have had no activity for at least WARN_BUSINESS_DAYS
 * business days. For each qualifying deal without an existing open task, creates
 * a task in VF Tasks with:
 *   - A due date set to the stale threshold (STALE_DAYS from last edit)
 *   - An assignee so the task surfaces in Notion's My Tasks view
 *   - A 💡 AI-generated suggested next step (Haiku) in the task page body
 *
 * Dedup: uses the existing pipeline relation properties on VF Tasks (Sales pipeline,
 * Partner pipeline, Comms pipeline) — if an open task already links to a deal,
 * no new task is created.
 *
 * Configuration:
 *   STALE_DAYS          — calendar days until a deal is "stale" (task due date)
 *   WARN_BUSINESS_DAYS  — business days of inactivity before task is created (default 1)
 *   TASKS_DB_ID         — VF Tasks Notion database ID
 *   NOTIFY_USER_ID      — Notion user UUID for task assignee
 *   PIPELINES           — per-pipeline DB ID + terminal status list
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STALE_DAYS         = 7;  // calendar days — task due date
const WARN_BUSINESS_DAYS = 1;  // business days of inactivity to trigger task creation

// VF Tasks database
const TASKS_DB_ID = '3528f55e5be14e96ad617d07e6b0beaa';

// Eve — Notion user UUID for task assignee
const NOTIFY_USER_ID = '08b11b55-f9b3-4dfa-b88b-9c57ab5cd6bf';

const PIPELINES = [
  {
    name: 'Sales',
    dbId: '2ed21e43d3a545f48cf4a2a8f61a264f',
    terminalStatuses: ['Lost/rejected', 'Completed', 'Signed 100%'],
    tasksRelationProp: 'Sales pipeline',
  },
  {
    name: 'Superfriend',
    dbId: 'a57e67c2b74548128c8157e433ffec92',
    terminalStatuses: ['Agreed partner'],
    tasksRelationProp: 'Partner pipeline',
  },
  {
    name: 'Comms',
    dbId: '35d10c8392e64ce2adc28c03e2c97480',
    terminalStatuses: ['Completed/Captured', 'Rejected/Cancelled', 'VF delivered'],
    tasksRelationProp: 'Comms pipeline',
  },
];

const PIPELINES_JSON = JSON.stringify(PIPELINES);

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const ANTHROPIC_CREDENTIAL = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the filter Code node JS for a given pipeline index. */
function buildFilterCode(pipelineIndex) {
  return `
const PIPELINES = ${PIPELINES_JSON};
const STALE_DAYS = ${STALE_DAYS};
const WARN_BUSINESS_DAYS = ${WARN_BUSINESS_DAYS};
const pipeline = PIPELINES[${pipelineIndex}];
const terminal = new Set(pipeline.terminalStatuses);

// Count business days (Mon-Fri) since a given ISO date string
function businessDaysSince(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  let count = 0;
  while (d < now) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

const stale = [];
for (const item of $input.all()) {
  const j = item.json;
  const status = j.property_status || '';
  if (terminal.has(status)) continue;

  const edited = j.property_last_edited_time;
  if (!edited) continue;

  const daysBusiness = businessDaysSince(edited);
  if (daysBusiness < WARN_BUSINESS_DAYS) continue;

  // Deadline: STALE_DAYS calendar days from last edit
  const stale_deadline = new Date(new Date(edited).getTime() + STALE_DAYS * 86400000)
    .toISOString().split('T')[0];

  stale.push({
    json: {
      page_id:        j.id,
      pipeline:       pipeline.name,
      deal_name:      j.name || '(untitled)',
      status,
      days_elapsed:   daysBusiness,
      stale_deadline,
      url:            j.url || '',
    },
  });
}

return stale.length > 0 ? stale : [{ json: { _empty: true } }];
`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Schedule Trigger — daily at 7 AM
const scheduleTrigger = createNode(
  'Daily 7 AM',
  'n8n-nodes-base.scheduleTrigger',
  { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } },
  { position: [0, 300], typeVersion: 1.2 },
);

// 2–4. Notion getAll — one per pipeline (parallel)
const getSales = createNode(
  'Get Sales Pipeline',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: PIPELINES[0].dbId },
    returnAll: true,
  },
  { position: [224, 100], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getSales.retryOnFail = true;
getSales.maxTries = 3;
getSales.waitBetweenTries = 1000;

const getSuperfriend = createNode(
  'Get Superfriend Pipeline',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: PIPELINES[1].dbId },
    returnAll: true,
  },
  { position: [224, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getSuperfriend.retryOnFail = true;
getSuperfriend.maxTries = 3;
getSuperfriend.waitBetweenTries = 1000;

const getComms = createNode(
  'Get Comms Pipeline',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: PIPELINES[2].dbId },
    returnAll: true,
  },
  { position: [224, 500], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getComms.retryOnFail = true;
getComms.maxTries = 3;
getComms.waitBetweenTries = 1000;

// 5–7. Filter Code nodes — apply business-day threshold and terminal status exclusion
const filterSales = createNode(
  'Filter Sales',
  'n8n-nodes-base.code',
  { jsCode: buildFilterCode(0), mode: 'runOnceForAllItems' },
  { position: [448, 100], typeVersion: 2 },
);

const filterSuperfriend = createNode(
  'Filter Superfriend',
  'n8n-nodes-base.code',
  { jsCode: buildFilterCode(1), mode: 'runOnceForAllItems' },
  { position: [448, 300], typeVersion: 2 },
);

const filterComms = createNode(
  'Filter Comms',
  'n8n-nodes-base.code',
  { jsCode: buildFilterCode(2), mode: 'runOnceForAllItems' },
  { position: [448, 500], typeVersion: 2 },
);

// 8–9. Merge (append) — combine all three filtered streams
const mergeSalesSuperfriend = createNode(
  'Merge Sales + Superfriend',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [672, 200], typeVersion: 3 },
);

const mergeAll = createNode(
  'Merge All Pipelines',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [896, 300], typeVersion: 3 },
);

// 10. Get Open Tasks — query VF Tasks for open tasks linked to any pipeline
// Uses raw Notion API (HTTP Request) to get full relation arrays (Notion node simplified output returns empty arrays for relations)
const getOpenTasks = createNode(
  'Get Open Tasks',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `https://api.notion.com/v1/databases/${TASKS_DB_ID}/query`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    // Filter: open status AND at least one pipeline relation set
    jsonBody: JSON.stringify({
      filter: {
        and: [
          {
            or: [
              { property: 'Status', status: { equals: 'Not started' } },
              { property: 'Status', status: { equals: 'In progress' } },
            ],
          },
          {
            or: [
              { property: 'Sales pipeline', relation: { is_not_empty: true } },
              { property: 'Partner pipeline', relation: { is_not_empty: true } },
              { property: 'Comms pipeline', relation: { is_not_empty: true } },
            ],
          },
        ],
      },
      page_size: 100,
    }),
    options: {
      pagination: {
        pagination: {
          paginationMode: 'updateAParameterInEachRequest',
          parameters: {
            parameters: [
              { name: 'start_cursor', type: 'body', value: '={{ $response.body.next_cursor }}' },
            ],
          },
          paginationCompleteWhen: 'other',
          completeExpression: '={{ !$response.body.has_more }}',
          limitPagesFetched: true,
          maxRequests: 100,
          requestInterval: 350,
        },
      },
    },
  },
  { position: [224, 700], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
getOpenTasks.retryOnFail = true;
getOpenTasks.maxTries = 3;
getOpenTasks.waitBetweenTries = 1000;

// 11. Merge Stale + Open Tasks — combine stale deals with open tasks query result
const mergeStaleAndTasks = createNode(
  'Merge Stale + Tasks',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [1120, 400], typeVersion: 3 },
);

// 12. Check, Dedup & Build Prompt — core logic node
const checkDedupAndBuild = createNode(
  'Check, Dedup & Build Prompt',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const TASKS_DB_ID    = '${TASKS_DB_ID}';
const NOTIFY_USER_ID = '${NOTIFY_USER_ID}';
const PIPELINES      = ${PIPELINES_JSON};

// Build pipeline name → VF Tasks relation property name map
const pipelineToRelProp = {};
for (const p of PIPELINES) pipelineToRelProp[p.name] = p.tasksRelationProp;

// Separate open-tasks API response from stale deal items
let openTasks = [];
const dealItems = [];

for (const item of $input.all()) {
  const j = item.json;
  if (Array.isArray(j.results)) {
    // Raw Notion API response from Get Open Tasks (has .results array)
    openTasks.push(...j.results);
  } else if (!j._empty) {
    dealItems.push(j);
  }
}

// Build set of (pipeline:deal_page_id) pairs that already have an open task
// Uses raw Notion API page objects so relation arrays are populated
const existingAlerts = new Set();
for (const task of openTasks) {
  const p = task.properties || {};
  for (const r of (p['Sales pipeline']?.relation || []))   existingAlerts.add('Sales:' + r.id);
  for (const r of (p['Partner pipeline']?.relation || [])) existingAlerts.add('Superfriend:' + r.id);
  for (const r of (p['Comms pipeline']?.relation || []))   existingAlerts.add('Comms:' + r.id);
}

const result = [];
for (const deal of dealItems) {
  if (existingAlerts.has(deal.pipeline + ':' + deal.page_id)) continue;
  if (!deal.stale_deadline) continue;

  const relProp   = pipelineToRelProp[deal.pipeline] || 'Sales pipeline';
  const taskName  = \`Follow up: \${deal.deal_name} (\${deal.pipeline})\`;

  const prompt = \`You are a CRM assistant. A deal has had no activity for \${deal.days_elapsed} business day(s) and must be advanced by \${deal.stale_deadline}.

Pipeline: \${deal.pipeline}
Deal: \${deal.deal_name}
Current Stage: \${deal.status}
Days Without Update: \${deal.days_elapsed}

Suggest ONE specific, actionable next step to advance this deal. 1-2 sentences only. Be direct and concrete.\`;

  const taskProperties = {
    parent: { database_id: TASKS_DB_ID },
    properties: {
      'Task name': { title: [{ text: { content: taskName } }] },
      Assignee:    { people: [{ id: NOTIFY_USER_ID }] },
      Due:         { date: { start: deal.stale_deadline } },
      Status:      { status: { name: 'Not started' } },
      Priority:    { select: { name: 'Medium' } },
      [relProp]:   { relation: [{ id: deal.page_id }] },
    },
  };

  result.push({
    json: {
      taskProperties,
      anthropicBody: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      },
    },
  });
}

return result;
`,
  },
  { position: [1344, 400], typeVersion: 2 },
);

// 13. Call Haiku — generate suggested next step via Anthropic API
const callHaiku = createNode(
  'Call Haiku',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'anthropic-version', value: '2023-06-01' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.anthropicBody }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 200 } },
    },
  },
  { position: [1568, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
callHaiku.retryOnFail = true;
callHaiku.maxTries = 2;
callHaiku.continueOnFail = true;

// 14. Merge Haiku + Context — preserve taskProperties through the data-replacing HTTP call
const mergeHaikuAndContext = createNode(
  'Merge Haiku + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [1792, 400], typeVersion: 3 },
);

// 15. Finalize Task Body — add AI suggestion as callout + rich text blocks in task page body
const finalizeTaskBody = createNode(
  'Finalize Task Body',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `
const raw = ($json.content?.[0]?.text || '').trim()
  || 'Review this deal and determine next steps.';

// --- Inline markdown → Notion rich_text array ---
function parseInline(text) {
  // Match **bold**, *italic*, and plain text segments
  const parts = [];
  const re = /(\\*\\*(.+?)\\*\\*|\\*(.+?)\\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', text: { content: text.slice(last, m.index) } });
    }
    if (m[2]) {
      // **bold**
      parts.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true } });
    } else if (m[3]) {
      // *italic*
      parts.push({ type: 'text', text: { content: m[3] }, annotations: { italic: true } });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push({ type: 'text', text: { content: text.slice(last) } });
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: { content: text } }];
}

// --- Parse lines into Notion blocks ---
const lines = raw.split('\\n');
const blocks = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  // Bulleted list: - or *
  const bulletMatch = trimmed.match(/^[-*]\\s+(.*)/);
  if (bulletMatch) {
    blocks.push({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: parseInline(bulletMatch[1]) },
    });
    continue;
  }

  // Numbered list: 1. 2. etc.
  const numMatch = trimmed.match(/^\\d+\\.\\s+(.*)/);
  if (numMatch) {
    blocks.push({
      type: 'numbered_list_item',
      numbered_list_item: { rich_text: parseInline(numMatch[1]) },
    });
    continue;
  }

  // Strip leading # headers — convert to plain paragraph
  const headerMatch = trimmed.match(/^#+\\s+(.*)/);
  const content = headerMatch ? headerMatch[1] : trimmed;

  blocks.push({
    type: 'paragraph',
    paragraph: { rich_text: parseInline(content) },
  });
}

// Fallback if nothing parsed
if (blocks.length === 0) {
  blocks.push({
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: 'Review this deal and determine next steps.' } }] },
  });
}

// Callout label + parsed blocks
const children = [
  {
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '💡' },
      rich_text: [{ type: 'text', text: { content: 'Suggested next step' } }],
      color: 'yellow_background',
    },
  },
  ...blocks,
];

return {
  json: {
    requestBody: {
      ...$json.taskProperties,
      children,
    },
  },
};
`,
  },
  { position: [2016, 400], typeVersion: 2 },
);

// 16. Create Task — POST to Notion /pages (includes children for task body)
const createTask = createNode(
  'Create Task',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [2240, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createTask.retryOnFail = true;
createTask.maxTries = 3;
createTask.continueOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Stale Pipeline Alerts', {
  nodes: [
    scheduleTrigger,
    getSales,
    getSuperfriend,
    getComms,
    filterSales,
    filterSuperfriend,
    filterComms,
    mergeSalesSuperfriend,
    mergeAll,
    getOpenTasks,
    mergeStaleAndTasks,
    checkDedupAndBuild,
    callHaiku,
    mergeHaikuAndContext,
    finalizeTaskBody,
    createTask,
  ],
  connections: [
    // Trigger → parallel branches
    connect(scheduleTrigger, getSales),
    connect(scheduleTrigger, getSuperfriend),
    connect(scheduleTrigger, getComms),
    connect(scheduleTrigger, getOpenTasks),

    // Notion → filter Code nodes
    connect(getSales, filterSales),
    connect(getSuperfriend, filterSuperfriend),
    connect(getComms, filterComms),

    // Filter → Merge chain (append)
    connect(filterSales, mergeSalesSuperfriend, 0, 0),
    connect(filterSuperfriend, mergeSalesSuperfriend, 0, 1),
    connect(mergeSalesSuperfriend, mergeAll, 0, 0),
    connect(filterComms, mergeAll, 0, 1),

    // Combine stale deals + open tasks
    connect(mergeAll, mergeStaleAndTasks, 0, 0),
    connect(getOpenTasks, mergeStaleAndTasks, 0, 1),

    // Core processing chain
    connect(mergeStaleAndTasks, checkDedupAndBuild),

    // Fork: checkDedupAndBuild → callHaiku (data path)
    connect(checkDedupAndBuild, callHaiku),
    // Fork: checkDedupAndBuild → mergeHaikuAndContext input 1 (passthrough for taskProperties)
    connect(checkDedupAndBuild, mergeHaikuAndContext, 0, 1),

    // callHaiku → mergeHaikuAndContext input 0 (AI response)
    connect(callHaiku, mergeHaikuAndContext, 0, 0),

    // Finalize and create
    connect(mergeHaikuAndContext, finalizeTaskBody),
    connect(finalizeTaskBody, createTask),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  active: false,
});
