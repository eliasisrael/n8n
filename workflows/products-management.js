import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const trigger = createNode('When Executed by Another Workflow', 'n8n-nodes-base.executeWorkflowTrigger', {
  workflowInputs: {
    values: [
      { name: 'title' },
      { name: 'description' },
      { name: 'type' },
      { name: 'thumbnail' },
      { name: 'price', type: 'number' },
      { name: 'notion_id' },
      { name: 'product_page_link' },
      { name: 'lms_id' },
      { name: 'visible', type: 'boolean' },
      { name: 'release_date' },
      { name: 'webflow_id' },
    ],
  },
}, {
  typeVersion: 1.1,
  position: [-1380, 80],
  id: '40a74a6b-e644-4a27-b64e-767d855b5e60',
});

const filter = createNode('Filter: Required Fields', 'n8n-nodes-base.filter', {
  conditions: {
    options: {
      caseSensitive: true,
      leftValue: '',
      typeValidation: 'strict',
      version: 2,
    },
    conditions: [
      {
        id: '9c612f2c-4414-4d66-9b1d-84731a4d5877',
        leftValue: '={{ $json.price }}',
        rightValue: '',
        operator: { type: 'number', operation: 'exists', singleValue: true },
      },
      {
        id: '775607c4-8efa-418c-b1aa-d5845088dc50',
        leftValue: '={{ $json.title }}',
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      },
      {
        id: '468f8b1b-1a44-4a2f-a2d3-73dc2e86aed6',
        leftValue: '={{ $json.description }}',
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      },
      {
        id: '24d3629c-11e5-4570-b787-dbc413822ead',
        leftValue: '={{ $json.thumbnail }}',
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      },
    ],
    combinator: 'and',
  },
  options: {},
}, {
  typeVersion: 2.2,
  position: [-1160, 80],
  id: '8031e15a-380d-4fa6-a74f-86d80001955e',
});

const alreadyStored = createNode('Already Stored?', 'n8n-nodes-base.if', {
  conditions: {
    options: {
      caseSensitive: true,
      leftValue: '',
      typeValidation: 'strict',
      version: 2,
    },
    conditions: [
      {
        id: 'b280b992-96aa-412f-848a-de8b6b1ac44b',
        leftValue: '={{ $json.webflow_id }}',
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      },
    ],
    combinator: 'and',
  },
  options: {},
}, {
  typeVersion: 2.2,
  position: [-940, 80],
  id: '80c16a90-6f8d-4a9f-b53d-09cb00f12ab3',
});

const updateProduct = createNode('Update Product', 'n8n-nodes-base.webflow', {
  operation: 'update',
  siteId: '66022db75af9853636d1ce23',
  collectionId: '67f509b0c6ce52de4d025242',
  itemId: '={{ $json.webflow_id }}',
  live: true,
  fieldsUi: {
    fieldValues: [
      { fieldId: 'thumbnail', fieldValue: '={{ $json.thumbnail}}' },
      { fieldId: 'description', fieldValue: '={{ $json.description }}' },
      { fieldId: 'type', fieldValue: '={{ $json.type }}' },
      { fieldId: 'publication-date', fieldValue: '={{ $json.release_date}}' },
      { fieldId: 'price', fieldValue: '={{ $json.price }}' },
      { fieldId: 'lms-id', fieldValue: '={{ $json.lms_id }}' },
      { fieldId: 'name', fieldValue: '={{ $json.title }}' },
      { fieldId: 'webflowid', fieldValue: '={{ $json.notion_id }}' },
      { fieldId: 'product-page-link', fieldValue: '={{ $json.product_page_link }}' },
      { fieldId: 'visible', fieldValue: '={{ $json.visible }}' },
    ],
  },
}, {
  typeVersion: 2,
  position: [-720, -20],
  id: '2209af07-8b2b-492c-8660-45c98ceadc9a',
  credentials: {
    webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
  },
});
updateProduct.retryOnFail = true;

const createProduct = createNode('Create Product', 'n8n-nodes-base.webflow', {
  operation: 'create',
  siteId: '66022db75af9853636d1ce23',
  collectionId: '67f509b0c6ce52de4d025242',
  live: '',
  fieldsUi: {
    fieldValues: [
      { fieldId: 'description', fieldValue: '={{ $json.description }}' },
      { fieldId: 'type', fieldValue: "={{ $json.type || 'DIGITAL_DOWNLOAD' }}" },
      { fieldId: 'publication-date', fieldValue: '={{ $json.release_date }}' },
      { fieldId: 'price', fieldValue: '={{ $json.price }}' },
      { fieldId: 'lms-id', fieldValue: '={{ $json.lms_id }}' },
      { fieldId: 'webflowid', fieldValue: '={{ $json.notion_id }}' },
      { fieldId: 'visible', fieldValue: '={{ $json.visible }}' },
      { fieldId: 'name', fieldValue: '={{ $json.title }}' },
      { fieldId: 'thumbnail', fieldValue: '={{ $json.thumbnail }}' },
    ],
  },
}, {
  typeVersion: 2,
  position: [-720, 180],
  id: '5edb4202-5806-46d0-8f25-3609fd4c65c6',
  credentials: {
    webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
  },
});
createProduct.retryOnFail = true;

const storeWebflowId = createNode('Store Webflow ID in Notion', 'n8n-nodes-base.notion', {
  resource: 'databasePage',
  operation: 'update',
  pageId: {
    __rl: true,
    value: "={{ $('When Executed by Another Workflow').item.json.notion_id }}",
    mode: 'id',
  },
  propertiesUi: {
    propertyValues: [
      {
        key: 'Webflow ID|rich_text',
        textContent: '={{ $json.id }}',
      },
    ],
  },
  options: {},
}, {
  typeVersion: 2.2,
  position: [-500, 180],
  id: '776c697e-e718-489d-82f5-d24821b75342',
  credentials: {
    notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
  },
});
storeWebflowId.retryOnFail = true;

const stickyNote = createNode('Sticky Note', 'n8n-nodes-base.stickyNote', {
  content: '## Notion Record\n\nWhat comes in is a new or updated record from Notion that needs to be reformatted and stored in Webflow',
  height: 140,
  width: 280,
  color: 4,
}, {
  typeVersion: 1,
  position: [-1400, -120],
  id: '4090f962-5b31-4b79-9f70-2cd84f678bda',
});

const stickyNote1 = createNode('Sticky Note1', 'n8n-nodes-base.stickyNote', {
  content: '## Publish\n\nCall the webflow API to publish these entries',
  color: 3,
}, {
  typeVersion: 1,
  position: [-520, 0],
  id: 'e82734f8-ac0f-4efc-8d96-35ec84d39c8a',
});

export default createWorkflow('Products Management', {
  nodes: [trigger, filter, alreadyStored, updateProduct, createProduct, storeWebflowId, stickyNote, stickyNote1],
  connections: [
    connect(trigger, filter),
    connect(filter, alreadyStored),
    connect(alreadyStored, updateProduct, 0),
    connect(alreadyStored, createProduct, 1),
    connect(createProduct, storeWebflowId),
  ],
  settings: { executionOrder: 'v1' },
  tags: [
    { id: 'iILieMiPiB391H0A', name: 'In Development' },
    { id: 'mSZQb74EXyrIkTsb', name: 'website' },
  ],
});
