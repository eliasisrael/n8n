/**
 * Clients Management — Sub-workflow
 *
 * Triggered by another workflow (Adapter: Clients) to sync client
 * records between Notion and Webflow.
 *
 * Logic:
 * - If already has WebflowId:
 *   - If still publishable (listed, has logo & name) → update Webflow
 *   - If no longer publishable → delete from Webflow, clear WebflowId in Notion
 * - If no WebflowId:
 *   - If active & publishable → create in Webflow, store WebflowId in Notion
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const WEBFLOW_CREDENTIAL = {
  webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
};

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  {
    id: 'd07b22bd-4012-48bf-a5c0-ee47813a8bd2',
    typeVersion: 1.1,
    position: [-1104, 48],
  },
);

const alreadyStored = createNode(
  'Already Stored?',
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
          id: '4bd52b16-e8bc-4cac-933f-481281f3c979',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'exists', singleValue: true },
        },
        {
          id: 'b280b992-96aa-412f-848a-de8b6b1ac44b',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '5bf6a22d-e5de-4392-8186-4f23c8e0bbee',
    typeVersion: 2.2,
    position: [-880, 48],
  },
);

const ifPublishable = createNode(
  'If Publishable',
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
          id: 'cac228da-f1d4-4cda-9643-c6f03b7e94fc',
          leftValue: '={{ $json["List on site?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: '18eb3527-9708-49cf-9764-91f18c5d85f5',
          leftValue: '={{ $json.Logo[0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'fe30fc96-2f9e-4a5b-b6a9-211488d87b0c',
          leftValue: '={{ $json.Name }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: 'f43377cc-c60c-451d-b505-8945fe5ed2ae',
    typeVersion: 2.2,
    position: [-656, -64],
  },
);

const updateWebflowRecord = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a24bb8d2e2ff85e8399e',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'logo', fieldValue: '={{ $json.Logo[0] }}' },
        { fieldId: 'notionid', fieldValue: '={{ $json.id }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  {
    id: 'e60b27a1-a9b7-4687-8c3e-911fd6feb24b',
    typeVersion: 2,
    position: [-448, -160],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
updateWebflowRecord.retryOnFail = true;

const deleteFromWebflow = createNode(
  'Delete from Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'deleteItem',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a24bb8d2e2ff85e8399e',
    itemId: '={{ $json.WebflowId }}',
  },
  {
    id: 'c2ce57b3-4c55-4fe4-98c9-efa9e5a7fe15',
    typeVersion: 2,
    position: [-448, 48],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
deleteFromWebflow.retryOnFail = true;

const removeWebflowIdFromNotion = createNode(
  'Remove webflow ID from notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: "={{ $('Already Stored?').item.json.id }}",
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        { key: '=WebflowId|rich_text' },
      ],
    },
    options: {},
  },
  {
    id: 'd21b262b-175d-4ffa-8a65-d8a3f3cf4e55',
    typeVersion: 2.2,
    position: [-224, 48],
    credentials: NOTION_CREDENTIAL,
  },
);
removeWebflowIdFromNotion.retryOnFail = true;

const activeAndPublishable = createNode(
  'Active and Publishable',
  'n8n-nodes-base.filter',
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
          id: 'ebbf7386-ddd1-4f40-b734-70c2902c14a7',
          leftValue: '={{ $json.Name }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '9f51f11a-fdf1-4782-8dfe-fd28aa98836e',
          leftValue: '={{ $json["List on site?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: 'a57bd202-d42c-46e2-ac8a-b737363d7d33',
          leftValue: '={{ $json.Logo[0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '92df2840-fcef-4fe1-8f99-12c57111b0e2',
    typeVersion: 2.2,
    position: [-656, 240],
  },
);
activeAndPublishable.retryOnFail = false;

const createInWebflow = createNode(
  'Create in Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a24bb8d2e2ff85e8399e',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
        { fieldId: 'logo', fieldValue: '={{ $json.Logo[0] }}' },
        { fieldId: 'notionid', fieldValue: '={{ $json.id }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  {
    id: 'ee3bae75-442b-4139-a420-a28a78a24939',
    typeVersion: 2,
    position: [-448, 240],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
createInWebflow.retryOnFail = true;

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: "={{ $('Active and Publishable').item.json.id }}",
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        { key: '=WebflowId|rich_text', textContent: '={{ $json.id }}' },
      ],
    },
    options: {},
  },
  {
    id: 'fcf6c34e-0532-43b4-b721-c9ece412e9a2',
    typeVersion: 2.2,
    position: [-224, 240],
    credentials: NOTION_CREDENTIAL,
  },
);
storeWebflowId.retryOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Clients Management', {
  nodes: [
    alreadyStored,
    storeWebflowId,
    updateWebflowRecord,
    deleteFromWebflow,
    removeWebflowIdFromNotion,
    activeAndPublishable,
    createInWebflow,
    ifPublishable,
    trigger,
  ],
  connections: [
    connect(trigger, alreadyStored),

    // Already stored → check publishability
    connect(alreadyStored, ifPublishable, 0, 0),
    // Not stored → create path
    connect(alreadyStored, activeAndPublishable, 1, 0),

    // Publishable → update
    connect(ifPublishable, updateWebflowRecord, 0, 0),
    // Not publishable → delete
    connect(ifPublishable, deleteFromWebflow, 1, 0),

    // Delete → remove ID from Notion
    connect(deleteFromWebflow, removeWebflowIdFromNotion),

    // Create path
    connect(activeAndPublishable, createInWebflow),
    connect(createInWebflow, storeWebflowId),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['Dev', 'website'],
});
