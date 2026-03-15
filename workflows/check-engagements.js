/**
 * Check Engagements
 *
 * Manually triggered workflow that iterates over all client engagement
 * financials in Notion, looks up matching forecast records, and for any
 * engagement that doesn't yet have a forecast, calls the Forecast Engine
 * sub-workflow to create one.
 *
 * Flow:
 * 1. Manual trigger → Get all engagement financials from Notion
 * 2. Loop over each engagement one at a time
 * 3. For each: look up forecast records by engagement ID, aggregate results
 * 4. Merge the engagement data with its forecast lookup
 * 5. If no forecast exists → extract key fields → call Forecast Engine
 * 6. If forecast exists → skip, loop to next
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const manualTrigger = createNode(
  "When clicking \u2018Execute workflow\u2019",
  'n8n-nodes-base.manualTrigger',
  {},
  {
    id: '8e19fa92-cc6f-4ae4-a422-54e86e75951e',
    typeVersion: 1,
    position: [0, -264],
  },
);

const getEngagements = createNode(
  'Get many database pages',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: '1c68ebaf-15ee-8062-80b2-fcb378557689',
      mode: 'list',
      cachedResultName: 'Client engagement financials',
      cachedResultUrl: 'https://www.notion.so/1c68ebaf15ee806280b2fcb378557689',
    },
    returnAll: true,
    options: {},
  },
  {
    id: '23882a88-6299-4ff0-ab9c-ece0fb7d0723',
    typeVersion: 2.2,
    position: [224, -264],
    credentials: NOTION_CREDENTIAL,
  },
);

const loopOverItems = createNode(
  'Loop Over Items',
  'n8n-nodes-base.splitInBatches',
  { options: {} },
  {
    id: '18be3c2c-b95d-4c2e-8f79-88528a03a22e',
    typeVersion: 3,
    position: [448, -264],
  },
);

const getForecast = createNode(
  'Get many database pages1',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: '1c98ebaf-15ee-809f-8a5f-ced93c82e98b',
      mode: 'list',
      cachedResultName: 'Forecast',
      cachedResultUrl: 'https://www.notion.so/1c98ebaf15ee809f8a5fced93c82e98b',
    },
    filterType: 'manual',
    filters: {
      conditions: [
        {
          key: 'Title|title',
          condition: 'starts_with',
          titleValue: '={{ $json.id }}',
        },
      ],
    },
    options: {},
  },
  {
    id: '54a73fde-eb77-4029-9354-73f6be56822b',
    typeVersion: 2.2,
    position: [672, -480],
    credentials: NOTION_CREDENTIAL,
  },
);
getForecast.executeOnce = false;
getForecast.alwaysOutputData = true;

const aggregate = createNode(
  'Aggregate',
  'n8n-nodes-base.aggregate',
  {
    aggregate: 'aggregateAllItemData',
    destinationFieldName: 'forecast',
    options: {},
  },
  {
    id: '5f5c4d06-d94a-4130-ad71-c1651c30e1ab',
    typeVersion: 1,
    position: [896, -480],
  },
);

const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  {
    id: '8fa65d76-6246-4c06-a738-6f3756fea163',
    typeVersion: 3.2,
    position: [1120, -408],
  },
);

const ifNode = createNode(
  'If',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'ad64b360-3aad-4e3c-a149-a04332e91fd3',
          leftValue: '={{ $json.forecast }}',
          rightValue: 1,
          operator: {
            type: 'array',
            operation: 'lengthEquals',
            rightType: 'number',
          },
        },
        {
          id: '98669f5a-91c8-444f-b0d4-df090c769710',
          leftValue: '={{ $json.forecast[0] }}',
          rightValue: '',
          operator: {
            type: 'object',
            operation: 'empty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: 'a4b99e21-726f-4a0d-8444-6a37559256c2',
    typeVersion: 2.2,
    position: [1344, -336],
  },
);

const editFields = createNode(
  'Edit Fields',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        { id: 'c7f40269-3b0e-4515-9604-6f2f324b3039', name: 'id', value: '={{ $json.id }}', type: 'string' },
        { id: '3bc27d5d-c9f4-464a-9c9f-b81724a1a83a', name: 'name', value: '={{ $json.name }}', type: 'string' },
        { id: '2c79189e-8fc6-4844-b56a-d19c9efb309a', name: 'url', value: '={{ $json.url }}', type: 'string' },
        { id: 'f0d47c37-1c3d-4f68-b660-2be4dcc97747', name: 'Engagement type', value: '={{ $json.property_engagement_type }}', type: 'array' },
        { id: '64d6047d-5230-4c28-9c21-0d9c343e285b', name: 'Cycle payment', value: '={{ $json.property_cycle_payment }}', type: 'number' },
        { id: 'e4d784c6-d448-4a0a-be68-5002be0175ab', name: 'Currency', value: '={{ $json.property_currency }}', type: 'string' },
        { id: '785220a7-2bf7-4aea-ad3b-d6c987eeeba4', name: 'Due at end', value: '={{ $json.property_due_at_end }}', type: 'number' },
        { id: 'cdfad658-c125-4a4d-af15-329dedb16a26', name: 'Cycle count', value: '={{ $json.property_cycle_count }}', type: 'number' },
        { id: '72426785-f4d4-4300-beb9-a9b9d20e0de0', name: 'Due at start', value: '={{ $json.property_due_at_start }}', type: 'number' },
        { id: 'fda14351-fa94-4c17-948c-67e4147cc277', name: 'Client db', value: '={{ $json.property_client_db }}', type: 'array' },
        { id: '8c7bd1d5-8295-454c-a3bc-abb96794aff4', name: 'Sales pipeline', value: '={{ $json.property_sales_pipeline }}', type: 'array' },
        { id: 'ec427823-7b9f-4ac3-a284-6af254399e2d', name: 'Notes', value: '={{ $json.property_notes }}', type: 'string' },
        { id: '2201ba57-7170-4ff0-9956-ec2feb1bd43b', name: 'Engagement start&end', value: '={{ $json.property_engagement_start_end }}', type: 'object' },
        { id: '1e0bd93a-3919-4f15-8176-93a7343a3e2c', name: 'Payment terms', value: '={{ $json.property_payment_terms }}', type: 'string' },
        { id: '37f861f5-7e51-45a5-9cc2-e871403059f6', name: 'Cycle length', value: '={{ $json.property_cycle_length }}', type: 'string' },
      ],
    },
    options: {},
  },
  {
    id: '424d934c-cdef-4b6f-8f0e-6ef7260061d8',
    typeVersion: 3.4,
    position: [1568, -336],
  },
);

const executeWorkflow = createNode(
  'Execute Workflow',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: '0VlE1zFPDaz94blF',
      mode: 'list',
      cachedResultName: 'Forecast Engine',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {},
      matchingColumns: [],
      schema: [],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {},
  },
  {
    id: '947e1973-bffb-4e72-9a2c-00abf253bd15',
    typeVersion: 1.2,
    position: [1792, -264],
  },
);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const workflow = createWorkflow('Check Engagements', {
  nodes: [
    manualTrigger,
    getEngagements,
    getForecast,
    loopOverItems,
    ifNode,
    merge,
    aggregate,
    editFields,
    executeWorkflow,
  ],
  connections: [
    // Trigger → get all engagements → loop
    connect(manualTrigger, getEngagements),
    connect(getEngagements, loopOverItems),

    // Loop output 1 (each item) → forecast lookup + merge input 0
    connect(loopOverItems, getForecast, 1, 0),
    connect(loopOverItems, merge, 1, 0),

    // Forecast lookup → aggregate → merge input 1
    connect(getForecast, aggregate),
    connect(aggregate, merge, 0, 1),

    // Merge → check if forecast exists
    connect(merge, ifNode),

    // No forecast (true) → extract fields → call Forecast Engine → loop back
    connect(ifNode, editFields, 0, 0),
    connect(editFields, executeWorkflow),
    connect(executeWorkflow, loopOverItems),

    // Has forecast (false) → loop back
    connect(ifNode, loopOverItems, 1, 0),
  ],
  settings: {},
  tags: [],
});

// Pad empty output for Loop Over Items output 0 (done branch, unused)
const conn = workflow.connections;
conn['Loop Over Items'].main[0] = [];

export default workflow;
