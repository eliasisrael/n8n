/**
 * Appearances Management — Sub-workflow
 *
 * Triggered by another workflow (the Adapter: Appearances) to sync appearance
 * records between Notion and Webflow.
 *
 * Logic:
 * - If the record already has a WebflowId (already stored):
 *   - Check if it's still public, publishable, and the right comms type
 *   - If yes → update the Webflow record
 *   - If no → delete from Webflow and unlink the WebflowId in Notion
 * - If the record does NOT have a WebflowId:
 *   - Check if it's public & publishable and the right comms type
 *   - If yes → create in Webflow and store the new WebflowId in Notion
 *
 * Handles Webflow delete errors: if a 404 is returned (item already gone),
 * it still unlinks the WebflowId from Notion.
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
// Webflow field mappings (shared between create and update)
// ---------------------------------------------------------------------------

const WEBFLOW_FIELDS = [
  { fieldId: 'event-name', fieldValue: '={{ $json["Event name"] }}' },
  { fieldId: 'start', fieldValue: '={{ $json["Delivery date"].start }}' },
  { fieldId: 'end', fieldValue: '={{ $json["Delivery date"].end }}' },
  { fieldId: 'photo', fieldValue: '={{ $json["Event image"][0] }}' },
  { fieldId: 'description', fieldValue: '={{ $json["Pre-event description"] }}' },
  { fieldId: 'post-event-description', fieldValue: '={{ $json["Post-event description"] }}' },
  { fieldId: 'location', fieldValue: '={{ $json.Location }}' },
  { fieldId: 'event-link', fieldValue: '={{ $json["Shareable Link"] }}' },
  { fieldId: 'category', fieldValue: '={{ $json["Comms type"][0] }}' },
  { fieldId: 'recordid', fieldValue: '={{ $json.id }}' },
  { fieldId: 'publication-window-start', fieldValue: '={{ $json["Publication window"].start }}' },
  { fieldId: 'publication-window-end', fieldValue: '={{ $json["Publication window"].end }}' },
  { fieldId: 'sticky', fieldValue: '={{ $json.Sticky }}' },
  { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
];

// ---------------------------------------------------------------------------
// Comms type conditions (shared between create-path filter and update-path IF)
// ---------------------------------------------------------------------------

const COMMS_TYPES = ['Appearance', 'Interview', 'Panel', 'Podcast', 'Talk', 'Webinar', 'Update'];

function makeCommsTypeConditions(ids) {
  return COMMS_TYPES.map((type, i) => ({
    id: ids[i],
    leftValue: '={{ $json["Comms type"] }}',
    rightValue: type,
    operator: {
      type: 'array',
      operation: 'contains',
      rightType: 'any',
    },
  }));
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  {
    id: 'c194ccf8-f8a7-4981-a53b-764ad92eeaaa',
    typeVersion: 1.1,
    position: [-1140, -135],
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
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '2e32323f-0059-4ff3-bfaf-1a51bef42ffb',
    typeVersion: 2.2,
    position: [-920, -135],
  },
);

const stillPublicAndPublishable = createNode(
  'Still public and publishable?',
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
          id: 'c165d19e-ecd3-49de-92a1-743686b380e0',
          leftValue: '={{ $json["Public?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: '0cf0a8f0-baeb-4c43-b113-889dee8f386d',
          leftValue: '={{ $json["Post-event description"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'f9f8b2b6-af8d-465c-8e2b-e3cd4f007643',
          leftValue: '={{ $json["Pre-event description"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'aacc0459-573d-4590-ba5f-bf30f1c63705',
          leftValue: '={{ $json["Event image"][0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '3961d022-3952-4967-aa56-a01f9e2098a1',
          leftValue: '={{ $json.Status }}',
          rightValue: '^(Confirmed|Delivered by me|Completed.Captured)$',
          operator: { type: 'string', operation: 'regex' },
        },
        {
          id: '13f6344c-5b62-465c-85af-11fe8abcae7c',
          leftValue: '={{ $json["Publication window"] }}',
          rightValue: '',
          operator: { type: 'object', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '7ba69267-b30b-4de7-bbbe-857e3b6956de',
    typeVersion: 2.2,
    position: [-700, -235],
  },
);

const publicAndPublishable = createNode(
  'Public & Publishable',
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
          id: '13d7e12f-fdc4-4c8b-9c70-10d02dc8a0d3',
          leftValue: '={{ $json["Public?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: '522df334-7e76-4b66-846e-d2ee1727a75e',
          leftValue: '={{ $json.Status }}',
          rightValue: '(Confirmed|Delivered by me|Completed.Captured)',
          operator: { type: 'string', operation: 'regex' },
        },
        {
          id: '32565c46-3760-4bab-808f-d97017818f10',
          leftValue: '={{ $json["Event image"] }}',
          rightValue: '',
          operator: { type: 'array', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '5016eb88-8e37-414c-b6d3-3e10b8b39959',
          leftValue: '={{ $json["Pre-event description"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '62842c31-2e41-4307-ae2b-0c03f4d9dae3',
          leftValue: '={{ $json["Post-event description"] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '0f4f917a-d6af-4393-bc7c-0feae08dce34',
          leftValue: '={{ $json["Publication window"] }}',
          rightValue: '',
          operator: { type: 'object', operation: 'exists', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '8e854802-40e8-4079-b4da-30ccca53b1a3',
    typeVersion: 2.2,
    position: [-700, 140],
  },
);
publicAndPublishable.alwaysOutputData = false;

const filterCommsType = createNode(
  'Filter: Comms Type',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: makeCommsTypeConditions([
        '1344d39a-e994-41da-8d2a-2b75a23612a3',
        '2ce770a0-4c8e-4d49-ae61-6cc0e50ad5c8',
        'fc4e650d-1f74-47de-9bf5-f7586e6fd1a3',
        'c96cacd8-ea09-46f0-9a80-931483343558',
        '887f8487-b9de-420e-9a4f-c44757acc3f1',
        '2f10b9cb-9148-4866-94fa-e8e1ce3eec7b',
        '498645c2-96f9-4e96-adac-17a6b98002f9',
      ]),
      combinator: 'or',
    },
    options: {},
  },
  {
    id: 'f5aaa120-f5c4-4b0d-b691-9e0320b364db',
    typeVersion: 2.2,
    position: [-480, 140],
  },
);

const webflowCreate = createNode(
  'Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099e748dae61ccc0110673',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_FIELDS },
  },
  {
    id: '8e37872f-e472-446d-8f43-c2b4d2026601',
    typeVersion: 2,
    position: [-260, 140],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
webflowCreate.retryOnFail = true;

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: '={{ $json.fieldData.recordid }}', mode: 'id' },
    propertiesUi: {
      propertyValues: [
        { key: 'WebflowId|rich_text', textContent: '={{ $json.id }}' },
      ],
    },
    options: {},
  },
  {
    id: '91a5dd93-4258-4657-9972-a78e1da71dba',
    typeVersion: 2.2,
    position: [-40, 140],
    credentials: NOTION_CREDENTIAL,
  },
);
storeWebflowId.retryOnFail = true;

const stillRightCommsType = createNode(
  'Still right comms type?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: makeCommsTypeConditions([
        'b5d8059d-c864-483a-85c1-64a506a25f40',
        '66ebf368-9374-4145-b1da-3aaebf8c7398',
        '7d6feeac-11a7-4163-9827-c14aebc5ae7e',
        '8837709f-fdbb-463f-98c9-e95f5d40232c',
        'e7478b0f-a371-425c-a12f-0a306643ebec',
        '14faf27b-d875-4f24-9049-eeb05a219abe',
        '53c6c988-9e76-4633-9ff9-7a3a968708a4',
      ]),
      combinator: 'or',
    },
    options: {},
  },
  {
    id: 'cf8ab480-2e6e-4eff-86b8-1e8540540845',
    typeVersion: 2.2,
    position: [-480, -310],
  },
);

const updateWebflowRecord = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099e748dae61ccc0110673',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_FIELDS },
  },
  {
    id: '55e3cff9-3276-4617-8f46-ea661a4914ae',
    typeVersion: 2,
    position: [-260, -360],
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
    collectionId: '66099e748dae61ccc0110673',
    itemId: '={{ $json.WebflowId }}',
  },
  {
    id: 'fa15edd2-7796-4813-b4a4-0c77d7a9be0d',
    typeVersion: 2,
    position: [-260, -140],
    credentials: WEBFLOW_CREDENTIAL,
  },
);
deleteFromWebflow.retryOnFail = true;
deleteFromWebflow.onError = 'continueErrorOutput';

const unlinkWebflowId = createNode(
  'Unlink Webflow ID',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: '={{ $json.id }}', mode: 'id' },
    propertiesUi: {
      propertyValues: [
        { key: 'WebflowId|rich_text', textContent: '={{ "" }}' },
      ],
    },
    options: {},
  },
  {
    id: 'f717125b-70b6-495d-b9fe-ec39bd715a12',
    typeVersion: 2.2,
    position: [160, -240],
    credentials: NOTION_CREDENTIAL,
  },
);
unlinkWebflowId.notesInFlow = true;
unlinkWebflowId.retryOnFail = true;
unlinkWebflowId.notes = 'BROKEN';

const filter404 = createNode(
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
          id: '221386e0-fa03-477e-a499-fc126920f0f5',
          leftValue: '={{ $json.error.cause.status }}',
          rightValue: 404,
          operator: { type: 'number', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    id: '2b6bc5fe-4663-4b79-9c2f-3af4cc006222',
    typeVersion: 2.2,
    position: [-40, -60],
  },
);

const unlinkWebflowId1 = createNode(
  'Unlink Webflow ID1',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: '={{ $(\'Still public and publishable?\').item.json.id }}',
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        { key: 'WebflowId|rich_text', textContent: '={{ "" }}' },
      ],
    },
    options: {},
  },
  {
    id: '380ea5d3-8cdc-4c14-b5fc-bf277479116d',
    typeVersion: 2.2,
    position: [160, -60],
    credentials: NOTION_CREDENTIAL,
  },
);
unlinkWebflowId1.notesInFlow = true;
unlinkWebflowId1.retryOnFail = true;
unlinkWebflowId1.notes = 'BROKEN';

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const workflow = createWorkflow('Appearances Management', {
  nodes: [
    trigger,
    alreadyStored,
    stillPublicAndPublishable,
    publicAndPublishable,
    filterCommsType,
    webflowCreate,
    storeWebflowId,
    stillRightCommsType,
    updateWebflowRecord,
    deleteFromWebflow,
    unlinkWebflowId,
    filter404,
    unlinkWebflowId1,
  ],
  connections: [
    // Entry
    connect(trigger, alreadyStored),

    // Already Stored? true (output 0) → check if still valid
    connect(alreadyStored, stillPublicAndPublishable, 0, 0),
    // Already Stored? false (output 1) → create path
    connect(alreadyStored, publicAndPublishable, 1, 0),

    // Create path: filter → create → store ID
    connect(publicAndPublishable, filterCommsType),
    connect(filterCommsType, webflowCreate),
    connect(webflowCreate, storeWebflowId, 0, 0),

    // Update path: still public? → still right type? → update
    connect(stillPublicAndPublishable, stillRightCommsType, 0, 0),
    // Not public anymore → delete
    connect(stillPublicAndPublishable, deleteFromWebflow, 1, 0),

    // Right comms type → update
    connect(stillRightCommsType, updateWebflowRecord, 0, 0),
    // Wrong comms type → delete
    connect(stillRightCommsType, deleteFromWebflow, 1, 0),

    // Delete success → unlink
    connect(deleteFromWebflow, unlinkWebflowId, 0, 0),
    // Delete error → filter for 404
    connect(deleteFromWebflow, filter404, 1, 0),

    // 404 error → still unlink
    connect(filter404, unlinkWebflowId1),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});

// Pad empty output arrays to match server topology
// (nodes with multiple outputs that have unused slots)
const c = workflow.connections;
c['Webflow'].main.push([]);                                 // unused error output
c['Store Webflow ID in Notion'] = { main: [[], []] };       // leaf node, 2 outputs
c['Update Webflow Record'] = { main: [[], []] };            // leaf node, 2 outputs
c['Unlink Webflow ID'] = { main: [[], []] };                // leaf node, 2 outputs

export default workflow;
