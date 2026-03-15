/**
 * Book Endorsements Management — Sub-workflow
 *
 * Triggered by another workflow (Adapter: Book Endorsements) to sync book
 * endorsement records between Notion and Webflow.
 *
 * Logic:
 * - If the record already has a WebflowId:
 *   - Filter for valid records (Name, Endorser Name, Title, Body all present)
 *   - Update the Webflow record
 * - If no WebflowId:
 *   - Filter for active/publishable (Endorser Name, Title, Body present)
 *   - Create in Webflow and store the new WebflowId in Notion
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
// Webflow field mappings
// ---------------------------------------------------------------------------

const WEBFLOW_UPDATE_FIELDS = [
  { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
  { fieldId: 'endorser-name', fieldValue: '={{ $json["Endorser Name"] }}' },
  { fieldId: 'endorser-title', fieldValue: '={{ $json["Ensorser Title"] }}' },
  { fieldId: 'organization', fieldValue: '={{ $json.Organization }}' },
  { fieldId: 'endorsemeny-body', fieldValue: '={{ $json["Endorsement Body"] }}' },
  { fieldId: 'enabled', fieldValue: '={{ $json.Enabled }}' },
  { fieldId: 'spotlight', fieldValue: '={{ $json.Spotlight }}' },
  { fieldId: 'endorser-title-2', fieldValue: '={{ $json["Endorser Title 2"] }}' },
  { fieldId: 'organization-2', fieldValue: '={{ $json["Organization 2"] }}' },
];

const WEBFLOW_CREATE_FIELDS = [
  { fieldId: 'endorser-name', fieldValue: '={{ $json["Endorser Name"] }}' },
  { fieldId: 'endorser-title', fieldValue: '={{ $json["Ensorser Title"] }}' },
  { fieldId: 'organization', fieldValue: '={{ $json.Organization }}' },
  { fieldId: 'endorsemeny-body', fieldValue: '={{ $json["Endorsement Body"] }}' },
  { fieldId: 'enabled', fieldValue: '={{ $json.Enabled }}' },
  { fieldId: 'spotlight', fieldValue: '={{ $json.Spotlight }}' },
  { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
  { fieldId: 'endorser-title-2', fieldValue: '={{ $json["Endorser Title 2"] }}' },
  { fieldId: 'organization-2', fieldValue: '={{ $json["Organization 2"] }}' },
];

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: '{\n  "NotionId":"",\n  "Name":"",\n"Endorser Name": "",\n  "Ensorser Title": "",\n  "Organization": "",\n  "Endorser Title 2": "",\n  "Organization 2": "",\n  "Endorsement Body": "",\n  "WebflowId": "",\n  "Enabled": true,\n  "Spotlight": true\n}',
  },
  {
    id: 'e73afb2e-36de-48fc-95c9-dbe35ba33d9e',
    typeVersion: 1.1,
    position: [-1104, -64],
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
    id: '721bece8-d5fa-499c-a9b7-63ea43a6f2d1',
    typeVersion: 2.2,
    position: [-880, -64],
  },
);

const filter = createNode(
  'Filter',
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
          id: '02af76c3-c68f-4a5e-81c0-c1c30a348df6',
          leftValue: '={{ $json.Name }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '73e4e065-ac2e-49c5-9e6d-26ab0d51e8e7',
          leftValue: '={{ $json["Endorser Name"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '749620c8-8ee3-454d-9b00-5f85d5bd8793',
          leftValue: '={{ $json["Ensorser Title"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'a39ac427-714c-4988-a099-509cbf23e405',
          leftValue: '={{ $json["Endorsement Body"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '3402499a-5fbb-45d4-8960-5af0366eeb2a',
    typeVersion: 2.2,
    position: [-656, -160],
  },
);

const updateWebflowRecord = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '692fb2357e327f7738ac8a9a',
    collectionId: '6987ad6901e1d91ad25128e0',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_UPDATE_FIELDS },
  },
  {
    id: '47ef1809-699a-4c4e-a580-6b44471e30d9',
    typeVersion: 2,
    position: [-432, -160],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
updateWebflowRecord.retryOnFail = true;

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
          id: 'a57bd202-d42c-46e2-ac8a-b737363d7d33',
          leftValue: '={{ $json["Endorser Name"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '94a0ec31-d831-477c-b2a9-e0aa1e5dec42',
          leftValue: '={{ $json["Ensorser Title"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'c7de0d02-3279-4e4c-a03e-ea411ff9e6cb',
          leftValue: '={{ $json["Endorsement Body"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '487bf79f-7f0a-42a2-92b2-472f4e0cfd39',
    typeVersion: 2.2,
    position: [-656, 32],
  },
);
activeAndPublishable.retryOnFail = false;

const createInWebflow = createNode(
  'Create in Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '692fb2357e327f7738ac8a9a',
    collectionId: '6987ad6901e1d91ad25128e0',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_CREATE_FIELDS },
  },
  {
    id: '00393552-ec4c-4a1c-877a-01a460b6bd0d',
    typeVersion: 2,
    position: [-432, 32],
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
      value: "={{ $('Active and Publishable').item.json.NotionId }}",
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        { key: '=WebflowID|rich_text', textContent: '={{ $json.id }}' },
      ],
    },
    options: {},
  },
  {
    id: 'b9fb32bc-744d-48ca-a751-bf2456e466e9',
    typeVersion: 2.2,
    position: [-208, 32],
    credentials: NOTION_CREDENTIAL,
  },
);
storeWebflowId.retryOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Book Endorsements Management', {
  nodes: [
    alreadyStored,
    storeWebflowId,
    updateWebflowRecord,
    activeAndPublishable,
    createInWebflow,
    trigger,
    filter,
  ],
  connections: [
    // Entry
    connect(trigger, alreadyStored),

    // Already Stored? true (output 0) → validate and update
    connect(alreadyStored, filter, 0, 0),
    // Already Stored? false (output 1) → create path
    connect(alreadyStored, activeAndPublishable, 1, 0),

    // Update path
    connect(filter, updateWebflowRecord),

    // Create path
    connect(activeAndPublishable, createInWebflow),
    connect(createInWebflow, storeWebflowId),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Dev'],
});
