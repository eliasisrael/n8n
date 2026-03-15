/**
 * Stale Pipeline Alerts → VF Tasks with AI Suggested Next Step
 *
 * MWF workflow that scans the Sales, Partner, and Comms pipeline
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
 *   STALE_DAYS_BY_PRIORITY       — calendar days until "stale" by priority (High: 3, Medium: 7, Low: 14)
 *   WARN_BUSINESS_DAYS_BY_PRIORITY — business days of inactivity before task creation (High: 1, Medium: 3, Low: 5)
 *   SALES_PRIORITY_MAP           — maps Sales pipeline priority values to High/Medium/Low
 *   TASKS_DB_ID                  — VF Tasks Notion database ID
 *   NOTIFY_USER_ID               — Notion user UUID for task assignee
 *   PIPELINES                    — per-pipeline DB ID + terminal status list
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Per-priority staleness thresholds (calendar days until task due date)
const STALE_DAYS_BY_PRIORITY = { High: 3, Medium: 7, Low: 14 };

// Per-priority business-day inactivity before creating a task
const WARN_BUSINESS_DAYS_BY_PRIORITY = { High: 1, Medium: 3, Low: 5 };

// Sales pipeline uses different Priority values — normalize to High/Medium/Low
const SALES_PRIORITY_MAP = {
  'Hot Prospects': 'High',
  'Active Projects': 'Medium',
  'Past Projects': 'Low',
  'Lost Projects': 'Low',
};

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
    tag: 'VF sales',
  },
  {
    name: 'Partner',
    dbId: '457cfa4c123b4718a7d3c8bf7ea4a27e',
    terminalStatuses: ['Closed/signed', 'Lost/rejected'],
    tasksRelationProp: 'Partner pipeline',
    tag: 'VF sales',
  },
  {
    name: 'Comms',
    dbId: '35d10c8392e64ce2adc28c03e2c97480',
    terminalStatuses: ['Completed/Captured', 'Rejected/Cancelled', 'VF delivered', 'Confirmed'],
    tasksRelationProp: 'Comms pipeline',
    tag: 'VF marketing',
  },
];

const PIPELINES_JSON = JSON.stringify(PIPELINES);
const STALE_DAYS_JSON = JSON.stringify(STALE_DAYS_BY_PRIORITY);
const WARN_DAYS_JSON = JSON.stringify(WARN_BUSINESS_DAYS_BY_PRIORITY);
const SALES_PRIORITY_MAP_JSON = JSON.stringify(SALES_PRIORITY_MAP);

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
const STALE_DAYS_BY_PRIORITY = ${STALE_DAYS_JSON};
const WARN_BUSINESS_DAYS_BY_PRIORITY = ${WARN_DAYS_JSON};
const SALES_PRIORITY_MAP = ${SALES_PRIORITY_MAP_JSON};
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

// Add N business days (Mon-Fri) to a date
function addBusinessDays(startISO, days) {
  const d = new Date(startISO);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d.toISOString().split('T')[0];
}

// Normalize priority to High/Medium/Low
function normalizePriority(rawPriority, pipelineName) {
  if (pipelineName === 'Sales') {
    return SALES_PRIORITY_MAP[rawPriority] || 'Medium';
  }
  // Partner and Comms already use High/Medium/Low
  if (['High', 'Medium', 'Low'].includes(rawPriority)) return rawPriority;
  return 'Medium'; // default for blank/missing
}

const stale = [];
for (const item of $input.all()) {
  const j = item.json;
  const status = j.property_status || '';
  if (terminal.has(status)) continue;

  const edited = j.property_last_edited_time || j.property_added || j.property_created_time;
  if (!edited) continue;

  const rawPriority = j.property_priority || '';
  const priority = normalizePriority(rawPriority, pipeline.name);
  const warnDays = WARN_BUSINESS_DAYS_BY_PRIORITY[priority] || 3;
  const staleDays = STALE_DAYS_BY_PRIORITY[priority] || 7;

  const daysBusiness = businessDaysSince(edited);
  if (daysBusiness < warnDays) continue;

  // Deadline: staleDays business days from today
  const stale_deadline = addBusinessDays(new Date().toISOString(), staleDays);

  stale.push({
    json: {
      page_id:        j.id,
      pipeline:       pipeline.name,
      deal_name:      j.name || '(untitled)',
      status,
      priority,
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

// 1. Schedule Trigger — Mon, Wed, Fri at 7 AM
const scheduleTrigger = createNode(
  'MWF 7 AM',
  'n8n-nodes-base.scheduleTrigger',
  { rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * 1,3,5' }] } },
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

const getPartner = createNode(
  'Get Partner Pipeline',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: PIPELINES[1].dbId },
    returnAll: true,
  },
  { position: [224, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getPartner.retryOnFail = true;
getPartner.maxTries = 3;
getPartner.waitBetweenTries = 1000;

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

const filterPartner = createNode(
  'Filter Partner',
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
const mergeSalesPartner = createNode(
  'Merge Sales + Partner',
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

// Build pipeline name → VF Tasks relation property name + tag maps
const pipelineToRelProp = {};
const pipelineToTag = {};
for (const p of PIPELINES) {
  pipelineToRelProp[p.name] = p.tasksRelationProp;
  pipelineToTag[p.name] = p.tag;
}

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

// Build map of (pipeline:deal_page_id) → { taskId, tags } for open tasks
// Uses raw Notion API page objects so relation arrays and Tags are populated
const existingAlerts = new Map();
for (const task of openTasks) {
  const p = task.properties || {};
  const currentTags = (p['Tags']?.multi_select || []).map(t => t.name);
  for (const r of (p['Sales pipeline']?.relation || []))
    existingAlerts.set('Sales:' + r.id, { taskId: task.id, tags: currentTags });
  for (const r of (p['Partner pipeline']?.relation || []))
    existingAlerts.set('Partner:' + r.id, { taskId: task.id, tags: currentTags });
  for (const r of (p['Comms pipeline']?.relation || []))
    existingAlerts.set('Comms:' + r.id, { taskId: task.id, tags: currentTags });
}

const result = [];
for (const deal of dealItems) {
  const alertKey = deal.pipeline + ':' + deal.page_id;
  const existing = existingAlerts.get(alertKey);
  if (existing) {
    // Dedup match — backfill tag if missing
    const expectedTag = pipelineToTag[deal.pipeline] || 'VF sales';
    if (!existing.tags.includes(expectedTag)) {
      const updatedTags = [...existing.tags, expectedTag];
      result.push({
        json: {
          _patchTags: true,
          taskId: existing.taskId,
          patchBody: {
            properties: {
              Tags: { multi_select: updatedTags.map(t => ({ name: t })) },
            },
          },
        },
      });
    }
    continue;
  }
  if (!deal.stale_deadline) continue;

  const relProp   = pipelineToRelProp[deal.pipeline] || 'Sales pipeline';
  const tag       = pipelineToTag[deal.pipeline] || 'VF sales';
  const taskName  = \`Follow up: \${deal.deal_name} (\${deal.pipeline})\`;

  const prompt = \`You are a CRM assistant. A deal has had no activity for \${deal.days_elapsed} business day(s) and must be advanced by \${deal.stale_deadline}.

Pipeline: \${deal.pipeline}
Deal: \${deal.deal_name}
Current Stage: \${deal.status}
Priority: \${deal.priority || 'Medium'}
Days Without Update: \${deal.days_elapsed}

Suggest ONE specific, actionable next step to advance this deal. 1-2 sentences only. Be direct and concrete.\`;

  const taskProperties = {
    parent: { database_id: TASKS_DB_ID },
    properties: {
      'Task name': { title: [{ text: { content: taskName } }] },
      Assignee:    { people: [{ id: NOTIFY_USER_ID }] },
      Due:         { date: { start: deal.stale_deadline } },
      Status:      { status: { name: 'Not started' } },
      Priority:    { select: { name: deal.priority || 'Medium' } },
      Tags:        { multi_select: [{ name: tag }] },
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

// 13. IF node — split tag-patch items from new-task items
const ifPatchTags = createNode(
  'Patch or Create?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          id: 'patch-tags-check',
          leftValue: '={{ $json._patchTags }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'exists', singleValue: true },
        },
        {
          id: 'patch-tags-true',
          leftValue: '={{ $json._patchTags }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: 'patch-body-exists',
          leftValue: '={{ $json.patchBody }}',
          rightValue: '',
          operator: { type: 'object', operation: 'exists', singleValue: true },
        },
        {
          id: 'patch-body-not-empty',
          leftValue: '={{ $json.patchBody }}',
          rightValue: '',
          operator: { type: 'object', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1568, 400], typeVersion: 2 },
);

// 14. Patch Task Tags — backfill missing tags on existing tasks
const patchTags = createNode(
  'Patch Task Tags',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{$json.taskId}}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.patchBody }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [1792, 200], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
patchTags.retryOnFail = true;
patchTags.maxTries = 3;
patchTags.continueOnFail = true;

// 15. Validate Create Items — ensure false-branch items have the required fields
const validateCreateItems = createNode(
  'Validate Create Items',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          id: 'anthropic-body-exists',
          leftValue: '={{ $json.anthropicBody }}',
          rightValue: '',
          operator: { type: 'object', operation: 'exists', singleValue: true },
        },
        {
          id: 'anthropic-body-not-empty',
          leftValue: '={{ $json.anthropicBody }}',
          rightValue: '',
          operator: { type: 'object', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'task-props-exists',
          leftValue: '={{ $json.taskProperties }}',
          rightValue: '',
          operator: { type: 'object', operation: 'exists', singleValue: true },
        },
        {
          id: 'task-props-not-empty',
          leftValue: '={{ $json.taskProperties }}',
          rightValue: '',
          operator: { type: 'object', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1792, 400], typeVersion: 2 },
);

// 15b. Stop on invalid items — malformed data that is neither patch nor create
const throwInvalidItem = createNode(
  'Throw Invalid Item',
  'n8n-nodes-base.stopAndError',
  {
    errorMessage: 'Item reached create branch without required fields (missing anthropicBody or taskProperties).',
  },
  { position: [2016, 600], typeVersion: 1 },
);

// 16. Call Haiku — generate suggested next step via Anthropic API
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
  { position: [2016, 500], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
callHaiku.retryOnFail = true;
callHaiku.maxTries = 2;
callHaiku.continueOnFail = true;

// 17. Merge Haiku + Context — preserve taskProperties through the data-replacing HTTP call
const mergeHaikuAndContext = createNode(
  'Merge Haiku + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [2240, 600], typeVersion: 3 },
);

// 18. Finalize Task Body — add AI suggestion as callout + rich text blocks in task page body
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
  { position: [2464, 600], typeVersion: 2 },
);

// 19. Create Task — POST to Notion /pages (includes children for task body)
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
  { position: [2688, 600], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
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
    getPartner,
    getComms,
    filterSales,
    filterPartner,
    filterComms,
    mergeSalesPartner,
    mergeAll,
    getOpenTasks,
    mergeStaleAndTasks,
    checkDedupAndBuild,
    ifPatchTags,
    patchTags,
    validateCreateItems,
    throwInvalidItem,
    callHaiku,
    mergeHaikuAndContext,
    finalizeTaskBody,
    createTask,
  ],
  connections: [
    // Trigger → parallel branches
    connect(scheduleTrigger, getSales),
    connect(scheduleTrigger, getPartner),
    connect(scheduleTrigger, getComms),
    connect(scheduleTrigger, getOpenTasks),

    // Notion → filter Code nodes
    connect(getSales, filterSales),
    connect(getPartner, filterPartner),
    connect(getComms, filterComms),

    // Filter → Merge chain (append)
    connect(filterSales, mergeSalesPartner, 0, 0),
    connect(filterPartner, mergeSalesPartner, 0, 1),
    connect(mergeSalesPartner, mergeAll, 0, 0),
    connect(filterComms, mergeAll, 0, 1),

    // Combine stale deals + open tasks
    connect(mergeAll, mergeStaleAndTasks, 0, 0),
    connect(getOpenTasks, mergeStaleAndTasks, 0, 1),

    // Core processing chain
    connect(mergeStaleAndTasks, checkDedupAndBuild),

    // Split: tag-patch items vs new-task items
    connect(checkDedupAndBuild, ifPatchTags),

    // True branch (output 0): patch missing tags on existing tasks
    connect(ifPatchTags, patchTags, 0, 0),

    // False branch (output 1): validate create items
    connect(ifPatchTags, validateCreateItems, 1, 0),

    // Valid items (output 0): Haiku + Create flow
    connect(validateCreateItems, callHaiku, 0, 0),
    connect(validateCreateItems, mergeHaikuAndContext, 0, 1),

    // Invalid items (output 1): throw error
    connect(validateCreateItems, throwInvalidItem, 1, 0),

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
