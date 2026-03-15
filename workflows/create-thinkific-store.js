import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Sticky Note ---
const stickyNote = createNode(
  'Sticky Note',
  'n8n-nodes-base.stickyNote',
  {
    content:
      "## Create The Store\n\nThis only should be run by hand. It was last run on 4/6/2025, so you probably shouldn't ever run it again. But it is here for reference.",
    width: 420,
  },
  {
    typeVersion: 1,
    position: [-200, -260],
    id: 'ed8f18c6-699d-4826-8b73-4052afa248bb',
  }
);

// --- Manual Trigger ---
const trigger = createNode(
  "When clicking \u2018Test workflow\u2019",
  'n8n-nodes-base.manualTrigger',
  {},
  {
    typeVersion: 1,
    position: [-220, -40],
    id: '0c8c03e0-8a8f-4e4c-bea9-59923aa1dd6e',
  }
);

// --- HTTP Request (Get Lists) ---
const getLists = createNode(
  'HTTP Request',
  'n8n-nodes-base.httpRequest',
  {
    url: 'https://us9.api.mailchimp.com/3.0/lists',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [0, -40],
    id: 'c994a058-808e-49d6-abed-4aa390b81806',
    credentials: {
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
    },
  }
);

// --- Code (Find List) ---
const code = createNode(
  'Code',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode:
      '\nreturn $input.item.json.lists.find(l => l.name === "Venn Factory, LLC")',
  },
  {
    typeVersion: 2,
    position: [220, -40],
    id: '37a35fe5-3f6f-4148-93ef-62a0c184dd0f',
  }
);

// --- Edit Fields (Build Store Payload) ---
const editFields = createNode(
  'Edit Fields',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '588f4c93-b0fc-4bfa-b991-696f8efc6ee3',
          name: 'id',
          value: 'venn-factory-learning',
          type: 'string',
        },
        {
          id: '270f337b-7964-41fd-892d-76cd94f5745d',
          name: 'list_id',
          value: '={{ $json.id }}',
          type: 'string',
        },
        {
          id: '273e03f4-ba86-44f0-9fa4-e4a0b812d8d1',
          name: 'name',
          value: 'Venn Factory Learnings',
          type: 'string',
        },
        {
          id: '0135b890-5ca2-46ce-90da-0baa58b9d788',
          name: 'platform',
          value: 'Teachable',
          type: 'string',
        },
        {
          id: 'd648ddfc-eaaf-4cdb-ac53-f20f8f35147a',
          name: 'domain',
          value: 'learning.vennfactory.com',
          type: 'string',
        },
        {
          id: '20869fbb-fd5d-4600-a986-22aa342567aa',
          name: 'email_address',
          value: 'eve@vennfactory.com',
          type: 'string',
        },
        {
          id: 'e42085e4-d814-4742-829c-6805eb4b0a8f',
          name: 'currency_code',
          value: 'USD',
          type: 'string',
        },
        {
          id: '469a9b0e-8175-4aa7-a015-22ad8f50e89b',
          name: 'money_format',
          value: '$',
          type: 'string',
        },
        {
          id: 'b2aef9e4-1710-4711-b924-54e0e72e7392',
          name: 'primary_locale',
          value: 'US',
          type: 'string',
        },
        {
          id: '5a596022-92a2-4e3c-92c3-ce0311d7fb43',
          name: 'timezone',
          value: 'Central',
          type: 'string',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [460, -40],
    id: '4b97a711-1574-4c5b-b760-6695c1b8e3cc',
  }
);

// --- HTTP Request1 (Create Store) ---
const createStore = createNode(
  'HTTP Request1',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://us9.api.mailchimp.com/3.0/ecommerce/stores',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.toJsonString() }}',
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [680, -40],
    id: '11793bfa-0d8d-44bb-a198-400b73a929e3',
    credentials: {
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
    },
  }
);

// --- Connections ---
const connections = [
  connect(trigger, getLists),
  connect(getLists, code),
  connect(code, editFields),
  connect(editFields, createStore),
];

export default createWorkflow('Create Thinkific Store', {
  nodes: [trigger, editFields, getLists, code, createStore, stickyNote],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
