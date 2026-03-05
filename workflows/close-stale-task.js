/**
 * Close Stale Task — Sub-workflow
 *
 * Triggered by the Notion Webhook Router when a pipeline deal page is updated.
 * Closes any open VF Tasks linked to that deal if the Status property was among
 * the changed properties (meaning a terminal status was set or the stage advanced).
 *
 * Close condition: body.data.updated_properties contains 'Status'
 * This covers both "moved to terminal status" and "stage advanced" — in both
 * cases the user deliberately changed the Status field, so the pending task
 * is no longer relevant.
 *
 * Expected input from the Notion Webhook Router Execute Workflow call:
 *   {
 *     body: {
 *       entity: { id: "<deal-page-id>" },
 *       data: {
 *         parent: { id: "<pipeline-db-id>" },   ← identifies which pipeline
 *         updated_properties: ["Status", ...]    ← tells us what changed
 *       },
 *       type: "page.properties_updated"
 *     },
 *     record: { ... }  ← full Notion page (not used here)
 *   }
 *
 * Pipeline DB ID → VF Tasks relation property mapping:
 *   35d10c83-92e6-4ce2-adc2-8c03e2c97480  →  "Comms pipeline"
 *   2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f  →  "Sales pipeline"
 *   a57e67c2-b745-4812-8c81-57e433ffec92  →  "Partner pipeline"
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TASKS_DB_ID = '3528f55e5be14e96ad617d07e6b0beaa'; // VF Tasks

// Map pipeline DB IDs (with dashes, as returned in webhook payloads)
// → VF Tasks relation property name used for dedup/lookup
const DB_TO_REL_PROP = {
  '35d10c83-92e6-4ce2-adc2-8c03e2c97480': 'Comms pipeline',
  '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f': 'Sales pipeline',
  'a57e67c2-b745-4812-8c81-57e433ffec92':  'Partner pipeline',
};

const DB_TO_REL_PROP_JSON = JSON.stringify(DB_TO_REL_PROP);

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Execute Workflow Trigger — receives webhook payload + Notion page record
//    from the Notion Webhook Router via Execute Workflow node
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
      record: {},
    }),
  },
  { typeVersion: 1.1, position: [0, 300] },
);

// 2. Check Status Changed & Build Query (Code, runOnceForAllItems)
//    - Drops items where Status is NOT in updated_properties
//    - Maps pipeline DB ID → VF Tasks relation property name
//    - Builds the Notion API query body (filter: open status + relation.contains deal)
const checkAndBuild = createNode(
  'Check Status Changed & Build Query',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const TASKS_DB_ID    = '${TASKS_DB_ID}';
const DB_TO_REL_PROP = ${DB_TO_REL_PROP_JSON};

const result = [];
for (const item of $input.all()) {
  const body    = item.json.body || {};
  const updated = Array.isArray(body.data?.updated_properties)
    ? body.data.updated_properties
    : [];

  // Only close tasks when Status was explicitly changed by the user
  if (!updated.includes('Status')) continue;

  const dbId       = body.data?.parent?.id || '';
  const dealPageId = body.entity?.id || '';
  const relProp    = DB_TO_REL_PROP[dbId];

  // Skip if we can't identify the pipeline or the deal page
  if (!relProp || !dealPageId) continue;

  result.push({
    json: {
      queryBody: {
        filter: {
          and: [
            {
              // Task must be open (not already done)
              or: [
                { property: 'Status', status: { equals: 'Not started' } },
                { property: 'Status', status: { equals: 'In progress' } },
              ],
            },
            {
              // Task must be linked to this specific deal
              property: relProp,
              relation: { contains: dealPageId },
            },
          ],
        },
        page_size: 10,
      },
    },
  });
}

// Empty result → downstream nodes don't execute (nothing to close)
return result;
`,
  },
  { typeVersion: 2, position: [250, 300] },
);

// 3. Query VF Tasks — find open tasks linked to this deal
//    Uses raw Notion API (HTTP Request) because the Notion node returns empty
//    arrays for relation data in its simplified output format.
const queryTasks = createNode(
  'Query VF Tasks',
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
queryTasks.retryOnFail = true;
queryTasks.maxTries = 3;
queryTasks.waitBetweenTries = 1000;
queryTasks.continueOnFail = true;

// 4. Extract Task IDs (Code, runOnceForAllItems)
//    Turns the Notion API `results` array into individual items, one per task.
//    Empty result (no open tasks found) → Close Task node doesn't execute.
const extractTaskIds = createNode(
  'Extract Task IDs',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `
const results = ($input.first()?.json?.results) || [];
return results
  .filter(task => task.id)
  .map(task => ({ json: { task_id: task.id } }));
`,
  },
  { typeVersion: 2, position: [750, 300] },
);

// 5. Close Task — mark each open task as Done via Notion API PATCH
const closeTask = createNode(
  'Close Task',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{$json.task_id}}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: JSON.stringify({
      properties: {
        Status: { status: { name: 'Done' } },
      },
    }),
  },
  { typeVersion: 4.2, credentials: NOTION_CREDENTIAL, position: [1000, 300] },
);
closeTask.retryOnFail = true;
closeTask.maxTries = 3;
closeTask.waitBetweenTries = 1000;
closeTask.continueOnFail = true;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Close Stale Task', {
  nodes: [trigger, checkAndBuild, queryTasks, extractTaskIds, closeTask],
  connections: [
    connect(trigger, checkAndBuild),
    connect(checkAndBuild, queryTasks),
    connect(queryTasks, extractTaskIds),
    connect(extractTaskIds, closeTask),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    // Sub-workflow: caller policy allows execution from the webhook router
    callerPolicy: 'workflowsFromSameOwner',
  },
  active: false,
});
