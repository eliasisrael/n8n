/**
 * Stage Entry Tasks — Sub-workflow
 *
 * Triggered by the Notion Webhook Router when a pipeline deal page's Status
 * property changes. Creates a proactive follow-up VF Task with a
 * stage-appropriate action item and AI-generated suggested next step.
 *
 * Lifecycle:
 *   1. Deal enters new stage → this workflow creates a follow-up task
 *   2. Stale Pipeline Alerts sees the open task → skips (dedup)
 *   3. User completes the task → marks Done
 *   4. If deal doesn't advance → Stale Pipeline Alerts creates a safety-net task
 *   5. When deal advances again → Close Stale Task closes old tasks,
 *      this workflow creates a new stage-appropriate task
 *
 * Terminal statuses are skipped — no task created when a deal is won/lost/completed.
 *
 * Expected input (from Notion Webhook Router Execute Workflow call):
 *   {
 *     body: {
 *       entity: { id: "<deal-page-id>" },
 *       data: {
 *         parent: { id: "<pipeline-db-id>" },
 *         updated_properties: ["Status", ...]
 *       },
 *       type: "page.properties_updated"
 *     },
 *     record: {
 *       id: "<page-id>",
 *       name: "<deal-name>",
 *       property_status: "<current-status>",
 *       ...
 *     }
 *   }
 *
 * Pipeline DB ID → stage task mapping:
 *   2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f  →  Sales pipeline
 *   457cfa4c-123b-4718-a7d3-c8bf7ea4a27e  →  Partner pipeline
 *   35d10c83-92e6-4ce2-adc2-8c03e2c97480  →  Comms pipeline
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TASKS_DB_ID = '3528f55e5be14e96ad617d07e6b0beaa'; // VF Tasks
const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8'; // Activities
const NOTIFY_USER_ID = '08b11b55-f9b3-4dfa-b88b-9c57ab5cd6bf'; // Eve

// Pipeline metadata: DB ID → relation property name + tag
const DB_TO_PIPELINE = {
  '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f': { name: 'Sales', relProp: 'Sales pipeline', tag: 'VF sales' },
  '457cfa4c-123b-4718-a7d3-c8bf7ea4a27e': { name: 'Partner', relProp: 'Partner pipeline', tag: 'VF sales' },
  '35d10c83-92e6-4ce2-adc2-8c03e2c97480': { name: 'Comms', relProp: 'Comms pipeline', tag: 'VF marketing' },
};

// Stage → task template mapping
// Only non-terminal stages are listed — terminal statuses produce no task.
// {deal} in taskName is replaced with the deal name at runtime.
const STAGE_TASKS = {
  // Sales Pipeline
  '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f': {
    'Captured 5%':     { taskName: 'Schedule discovery call: {deal}', dueDays: 3, priority: 'Medium' },
    'Qualified 25%':   { taskName: 'Create proposal: {deal}',       dueDays: 3, priority: 'High' },
    'Proposed 50%':    { taskName: 'Follow up on proposal: {deal}', dueDays: 5, priority: 'Medium' },
    'Negotiating 90%': { taskName: 'Finalize contract: {deal}',     dueDays: 5, priority: 'High' },
  },
  // Partner Pipeline
  '457cfa4c-123b-4718-a7d3-c8bf7ea4a27e': {
    'Lead':        { taskName: 'Research partner opportunity: {deal}',  dueDays: 3, priority: 'Medium' },
    'Qualified':   { taskName: 'Schedule intro call: {deal}',          dueDays: 5, priority: 'Medium' },
    'Negotiation': { taskName: 'Prepare partnership proposal: {deal}', dueDays: 5, priority: 'High' },
  },
  // Comms Pipeline
  '35d10c83-92e6-4ce2-adc2-8c03e2c97480': {
    'Lead':      { taskName: 'Research media opportunity: {deal}', dueDays: 3, priority: 'Medium' },
    'Proposed':  { taskName: 'Follow up on pitch: {deal}',        dueDays: 5, priority: 'Medium' },
  },
};

// Terminal statuses: DB ID → { status → outcome type }
// When a deal reaches one of these, an Activity record is created.
const TERMINAL_STATUSES = {
  // Sales Pipeline
  '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f': {
    'Signed 100%':   'Deal Won',
    'Completed':     'Deal Won',
    'Lost/rejected': 'Deal Lost',
  },
  // Partner Pipeline
  '457cfa4c-123b-4718-a7d3-c8bf7ea4a27e': {
    'Closed/signed': 'Deal Won',
    'Lost/rejected': 'Deal Lost',
  },
  // Comms Pipeline
  '35d10c83-92e6-4ce2-adc2-8c03e2c97480': {
    'Confirmed':          'Deal Won',
    'Completed/Captured': 'Deal Won',
    'VF delivered':       'Deal Won',
    'Rejected/Cancelled': 'Deal Lost',
  },
};

const TERMINAL_STATUSES_JSON = JSON.stringify(TERMINAL_STATUSES);

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const ANTHROPIC_CREDENTIAL = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// Serialize config for embedding in Code node JS
const DB_TO_PIPELINE_JSON = JSON.stringify(DB_TO_PIPELINE);
const STAGE_TASKS_JSON = JSON.stringify(STAGE_TASKS);

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Execute Workflow Trigger — receives webhook payload + Notion page record
const trigger = createNode(
  'Execute Workflow Trigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: JSON.stringify({
      body: {
        entity: { id: 'notion-page-uuid' },
        data: {
          parent: { id: 'notion-db-uuid' },
          updated_properties: ['Status'],
        },
        type: 'page.properties_updated',
      },
      record: {
        id: 'notion-page-uuid',
        name: 'Example Deal',
        property_status: 'Qualified',
      },
    }),
  },
  { typeVersion: 1.1, position: [0, 300] },
);

// 2. Check Status & Build Plan — filter + lookup + build task plan + dedup query
const checkAndBuild = createNode(
  'Check Status & Build Plan',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const TASKS_DB_ID    = '${TASKS_DB_ID}';
const NOTIFY_USER_ID = '${NOTIFY_USER_ID}';
const DB_TO_PIPELINE = ${DB_TO_PIPELINE_JSON};
const STAGE_TASKS    = ${STAGE_TASKS_JSON};

// Add N business days to a date (skip weekends)
function addBusinessDays(startISO, days) {
  const d = new Date(startISO);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

const result = [];
for (const item of $input.all()) {
  const body    = item.json.body || {};
  const record  = item.json.record || {};
  const updated = Array.isArray(body.data?.updated_properties)
    ? body.data.updated_properties
    : [];

  // Only act when Status was explicitly changed
  if (!updated.includes('Status')) continue;

  const dbId       = body.data?.parent?.id || '';
  const dealPageId = body.entity?.id || '';
  const pipeline   = DB_TO_PIPELINE[dbId];
  const stageMap   = STAGE_TASKS[dbId];

  // Skip unknown pipelines
  if (!pipeline || !stageMap || !dealPageId) continue;

  // Read current status from the simplified Notion page record
  const currentStatus = record.property_status || '';

  // Look up stage template — skip terminal statuses (not in the map)
  const template = stageMap[currentStatus];
  if (!template) continue;

  const dealName = record.name || 'Unnamed Deal';
  const taskName = template.taskName.replace('{deal}', dealName);
  const dueDate  = addBusinessDays(new Date().toISOString(), template.dueDays);

  // Build AI prompt
  const prompt = \`You are a CRM assistant. A deal just entered a new stage and needs a follow-up action.

Pipeline: \${pipeline.name}
Deal: \${dealName}
New Stage: \${currentStatus}

Suggest ONE specific, actionable next step to advance this deal. 1-2 sentences only. Be direct and concrete.\`;

  result.push({
    json: {
      taskName,
      taskProperties: {
        parent: { database_id: TASKS_DB_ID },
        properties: {
          'Task name': { title: [{ text: { content: taskName } }] },
          Assignee:    { people: [{ id: NOTIFY_USER_ID }] },
          Due:         { date: { start: dueDate } },
          Status:      { status: { name: 'Not started' } },
          Priority:    { select: { name: template.priority } },
          Tags:        { multi_select: [{ name: pipeline.tag }] },
          [pipeline.relProp]: { relation: [{ id: dealPageId }] },
        },
      },
      anthropicBody: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      },
      // Dedup query: find open tasks linked to this deal
      queryBody: {
        filter: {
          and: [
            {
              or: [
                { property: 'Status', status: { equals: 'Not started' } },
                { property: 'Status', status: { equals: 'In progress' } },
              ],
            },
            {
              property: pipeline.relProp,
              relation: { contains: dealPageId },
            },
          ],
        },
        page_size: 20,
      },
    },
  });
}

return result;
`,
  },
  { typeVersion: 2, position: [250, 300] },
);

// 3. Query Open Tasks — find existing open tasks linked to this deal (for dedup)
const queryOpenTasks = createNode(
  'Query Open Tasks',
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
    jsonBody: '={{ $json.queryBody }}',
  },
  { typeVersion: 4.2, credentials: NOTION_CREDENTIAL, position: [500, 300] },
);
queryOpenTasks.retryOnFail = true;
queryOpenTasks.maxTries = 3;
queryOpenTasks.waitBetweenTries = 1000;
queryOpenTasks.continueOnFail = true;

// 4. Merge Query + Context — recombine query results with the task plan
//    Input 0: query results (from Query Open Tasks)
//    Input 1: original plan (fork from Check Status & Build Plan)
const mergeQueryAndPlan = createNode(
  'Merge Query + Plan',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [750, 400], typeVersion: 3 },
);

// 5. Skip If Duplicate — drop items where a task with the same name already exists
const skipIfDuplicate = createNode(
  'Skip If Duplicate',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const result = [];
for (const item of $input.all()) {
  const taskName     = item.json.taskName || '';
  const existingTasks = item.json.results || [];

  // Check if any existing open task has the same name
  const isDuplicate = existingTasks.some(task => {
    const title = task.properties?.['Task name']?.title?.[0]?.text?.content || '';
    return title === taskName;
  });

  if (isDuplicate) continue;

  // Pass through — strip query results, keep task plan
  result.push({
    json: {
      taskProperties: item.json.taskProperties,
      anthropicBody:  item.json.anthropicBody,
    },
  });
}

return result;
`,
  },
  { typeVersion: 2, position: [1000, 400] },
);

// 6. Call Haiku — generate suggested next step via Anthropic API
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
  { position: [1250, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
callHaiku.retryOnFail = true;
callHaiku.maxTries = 2;
callHaiku.continueOnFail = true;

// 7. Merge Haiku + Context — recombine AI response with task plan
//    Input 0: Haiku response (from Call Haiku)
//    Input 1: task plan (fork from Skip If Duplicate)
const mergeHaikuAndContext = createNode(
  'Merge Haiku + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [1500, 400], typeVersion: 3 },
);

// 8. Finalize Task Body — build Notion page with AI suggestion as rich-text body
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
  const parts = [];
  const re = /(\\*\\*(.+?)\\*\\*|\\*(.+?)\\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', text: { content: text.slice(last, m.index) } });
    }
    if (m[2]) {
      parts.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true } });
    } else if (m[3]) {
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

  const bulletMatch = trimmed.match(/^[-*]\\s+(.*)/);
  if (bulletMatch) {
    blocks.push({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: parseInline(bulletMatch[1]) },
    });
    continue;
  }

  const numMatch = trimmed.match(/^\\d+\\.\\s+(.*)/);
  if (numMatch) {
    blocks.push({
      type: 'numbered_list_item',
      numbered_list_item: { rich_text: parseInline(numMatch[1]) },
    });
    continue;
  }

  const headerMatch = trimmed.match(/^#+\\s+(.*)/);
  const content = headerMatch ? headerMatch[1] : trimmed;

  blocks.push({
    type: 'paragraph',
    paragraph: { rich_text: parseInline(content) },
  });
}

if (blocks.length === 0) {
  blocks.push({
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: 'Review this deal and determine next steps.' } }] },
  });
}

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
  { position: [1750, 400], typeVersion: 2 },
);

// 9. Create Task — POST to Notion /pages
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
  { position: [2000, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createTask.retryOnFail = true;
createTask.maxTries = 3;
createTask.waitBetweenTries = 1000;
createTask.continueOnFail = true;

// ---------------------------------------------------------------------------
// Outcome Log — parallel branch for terminal statuses
// ---------------------------------------------------------------------------

// 10. Check Terminal Status — build Activity creation body if deal is at terminal status
const checkTerminalStatus = createNode(
  'Check Terminal Status',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const ACTIVITIES_DB_ID = '${ACTIVITIES_DB_ID}';
const DB_TO_PIPELINE   = ${DB_TO_PIPELINE_JSON};
const TERMINAL_STATUSES = ${TERMINAL_STATUSES_JSON};

const result = [];
for (const item of $input.all()) {
  const body    = item.json.body || {};
  const record  = item.json.record || {};
  const updated = Array.isArray(body.data?.updated_properties)
    ? body.data.updated_properties
    : [];

  // Only act when Status was explicitly changed
  if (!updated.includes('Status')) continue;

  const dbId       = body.data?.parent?.id || '';
  const dealPageId = body.entity?.id || '';
  const pipeline   = DB_TO_PIPELINE[dbId];
  const terminalMap = TERMINAL_STATUSES[dbId];

  if (!pipeline || !terminalMap || !dealPageId) continue;

  const currentStatus = record.property_status || '';
  const outcomeType   = terminalMap[currentStatus];
  if (!outcomeType) continue; // Not a terminal status

  const dealName = record.name || 'Unnamed Deal';

  // Calculate days in pipeline
  const createdAt = record.property_created_time || record.property_added || '';
  const daysInPipeline = createdAt
    ? Math.round((Date.now() - new Date(createdAt).getTime()) / 86400000)
    : null;

  const preview = daysInPipeline !== null
    ? \`\${pipeline.name} · \${currentStatus} · \${daysInPipeline} days in pipeline\`
    : \`\${pipeline.name} · \${currentStatus}\`;

  // Build contact relation array from record (if available)
  const contactIds = Array.isArray(record.property_contact)
    ? record.property_contact.map(id => ({ id }))
    : typeof record.property_contact === 'string' && record.property_contact
      ? [{ id: record.property_contact }]
      : [];

  // Build the Activity creation body
  const activityBody = {
    parent: { database_id: ACTIVITIES_DB_ID },
    properties: {
      Name:    { title: [{ text: { content: \`\${outcomeType}: \${dealName}\` } }] },
      Type:    { select: { name: outcomeType } },
      Date:    { date: { start: new Date().toISOString() } },
      Preview: { rich_text: [{ text: { content: preview } }] },
      [pipeline.relProp]: { relation: [{ id: dealPageId }] },
    },
  };

  // Add contact relation if available
  if (contactIds.length > 0) {
    activityBody.properties.Contact = { relation: contactIds };
  }

  // Dedup query: check if outcome Activity already exists for this deal
  const queryBody = {
    filter: {
      and: [
        {
          property: pipeline.relProp,
          relation: { contains: dealPageId },
        },
        {
          or: [
            { property: 'Type', select: { equals: 'Deal Won' } },
            { property: 'Type', select: { equals: 'Deal Lost' } },
          ],
        },
      ],
    },
    page_size: 1,
  };

  result.push({
    json: { activityBody, queryBody },
  });
}

return result;
`,
  },
  { typeVersion: 2, position: [250, 600] },
);

// 11. Query Existing Outcomes — check for duplicate outcome records
const queryExistingOutcomes = createNode(
  'Query Existing Outcomes',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `https://api.notion.com/v1/databases/${ACTIVITIES_DB_ID}/query`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.queryBody }}',
  },
  { typeVersion: 4.2, credentials: NOTION_CREDENTIAL, position: [500, 600] },
);
queryExistingOutcomes.retryOnFail = true;
queryExistingOutcomes.maxTries = 3;
queryExistingOutcomes.waitBetweenTries = 1000;
queryExistingOutcomes.continueOnFail = true;

// 12. Merge Outcome Query + Context
const mergeOutcomeQuery = createNode(
  'Merge Outcome Query + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [750, 700], typeVersion: 3 },
);

// 13. No Existing Outcome? — filter: only pass items with no existing outcome Activity
const noExistingOutcome = createNode(
  'No Existing Outcome?',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'outcome-dedup',
          leftValue: '={{ $json.results.length }}',
          rightValue: 0,
          operator: { type: 'number', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1000, 700], typeVersion: 2 },
);

// 14. Create Outcome Activity — POST to Notion /pages
const createOutcomeActivity = createNode(
  'Create Outcome Activity',
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
    jsonBody: '={{ $json.activityBody }}',
  },
  { typeVersion: 4.2, credentials: NOTION_CREDENTIAL, position: [1250, 700] },
);
createOutcomeActivity.retryOnFail = true;
createOutcomeActivity.maxTries = 3;
createOutcomeActivity.waitBetweenTries = 1000;
createOutcomeActivity.continueOnFail = true;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Stage Entry Tasks', {
  nodes: [
    trigger,
    checkAndBuild,
    queryOpenTasks,
    mergeQueryAndPlan,
    skipIfDuplicate,
    callHaiku,
    mergeHaikuAndContext,
    finalizeTaskBody,
    createTask,
    checkTerminalStatus,
    queryExistingOutcomes,
    mergeOutcomeQuery,
    noExistingOutcome,
    createOutcomeActivity,
  ],
  connections: [
    // Trigger → Check Status & Build Plan
    connect(trigger, checkAndBuild),

    // Check & Build → Query Open Tasks (dedup query)
    connect(checkAndBuild, queryOpenTasks),

    // Fork: Check & Build → Merge Query + Plan input 1 (passthrough for task plan)
    connect(checkAndBuild, mergeQueryAndPlan, 0, 1),

    // Query results → Merge Query + Plan input 0
    connect(queryOpenTasks, mergeQueryAndPlan, 0, 0),

    // Merge → Skip If Duplicate
    connect(mergeQueryAndPlan, skipIfDuplicate),

    // Fork: Skip If Duplicate → Call Haiku (AI path)
    connect(skipIfDuplicate, callHaiku),

    // Fork: Skip If Duplicate → Merge Haiku + Context input 1 (passthrough)
    connect(skipIfDuplicate, mergeHaikuAndContext, 0, 1),

    // Call Haiku → Merge Haiku + Context input 0
    connect(callHaiku, mergeHaikuAndContext, 0, 0),

    // Merge → Finalize Task Body
    connect(mergeHaikuAndContext, finalizeTaskBody),

    // Finalize → Create Task
    connect(finalizeTaskBody, createTask),

    // --- Outcome Log branch (parallel from trigger) ---

    // Trigger → Check Terminal Status
    connect(trigger, checkTerminalStatus),

    // Check Terminal Status → Query Existing Outcomes (dedup query)
    connect(checkTerminalStatus, queryExistingOutcomes),

    // Fork: Check Terminal Status → Merge Outcome Query input 1 (passthrough)
    connect(checkTerminalStatus, mergeOutcomeQuery, 0, 1),

    // Query results → Merge Outcome Query input 0
    connect(queryExistingOutcomes, mergeOutcomeQuery, 0, 0),

    // Merge → Skip If Outcome Exists
    connect(mergeOutcomeQuery, noExistingOutcome),

    // Skip If Outcome Exists → Create Outcome Activity
    connect(noExistingOutcome, createOutcomeActivity),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
  active: false,
});
