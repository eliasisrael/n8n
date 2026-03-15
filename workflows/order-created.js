import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Sticky Note ---
const stickyNote = createNode(
  'Sticky Note',
  'n8n-nodes-base.stickyNote',
  {
    content: '## An Order Was Placed In Thinkific\nTell **Mailchimp** about the order so that segments can be created around them',
    width: 280,
    color: 4,
  },
  {
    typeVersion: 1,
    position: [-380, -260],
    id: 'f1839aa6-621e-4f0a-b342-d71150f18b5b',
  }
);

// --- Sticky Note1 ---
const stickyNote1 = createNode(
  'Sticky Note1',
  'n8n-nodes-base.stickyNote',
  {
    content: '## TODO\nMake sure that product IDs match between product definition and product purchase',
    width: 320,
    color: 3,
  },
  {
    typeVersion: 1,
    position: [80, -240],
    id: '619aaaaa-f3ec-4c2b-8a4d-46269aba26cb',
  }
);

// --- Webhook (Order Created) ---
const webhook = createNode(
  'Order Created',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: '878929d3-9616-4a35-af2a-4a726f4ef53a',
    responseMode: 'responseNode',
    options: {},
  },
  {
    typeVersion: 2,
    position: [-420, -40],
    id: '479f98c2-7ce9-434a-85b8-e4af82f7ac65',
  }
);
webhook.webhookId = '878929d3-9616-4a35-af2a-4a726f4ef53a';

// --- Edit Customer Object ---
const editCustomer = createNode(
  'Edit Customer Object',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'd24e7ba9-a861-4f55-8f75-17b892438127',
          name: 'customer.id',
          value: '={{ $json.body.payload.user.email }}',
          type: 'string',
        },
        {
          id: '5df6eb34-b57a-46e5-ae73-b78decf4cd9f',
          name: 'customer.email_address',
          value: '={{ $json.body.payload.user.email }}',
          type: 'string',
        },
        {
          id: 'ea8f65c9-0b8f-4c8d-8973-556d6dfe0635',
          name: 'customer.first_name',
          value: '={{ $json.body.payload.user.first_name }}',
          type: 'string',
        },
        {
          id: '458c7329-c6b3-48a2-bb12-3f1962144b8b',
          name: 'customer.last_name',
          value: '={{ $json.body.payload.user.last_name }}',
          type: 'string',
        },
        {
          id: 'e497f472-df4c-4909-842f-ee42981a76fb',
          name: 'customer.opt_in_status',
          value: true,
          type: 'boolean',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [-200, -40],
    id: 'af95c212-fb07-467b-b1e9-4745f2ef2692',
  }
);

// --- Add Line Items (Code) ---
const addLineItems = createNode(
  'Add Line Items',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: "let formatItem = (item, ndx) => {\n  return {\n    \"id\": \"LINE-\"+ndx,\n    \"product_id\": item.product_id.toString(),\n    \"product_variant_id\": item.product_id.toString(),\n    \"quantity\": item.quantity,\n    \"price\": item.amount_dollars,\n    \"discount\": 0\n  }\n};\n\n$input.item.json.lines = $input.item.json.body.payload.items.map(formatItem);\n\nreturn $input.item;",
  },
  {
    typeVersion: 2,
    position: [20, -40],
    id: 'e48d550e-a718-4543-a8e9-23fb23d12b51',
  }
);

// --- Save Order to Mailchimp (Execute Workflow) ---
const saveOrder = createNode(
  'Save Order to Mailchimp',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: 'BrpfLGxPLAbzAfQU',
      mode: 'list',
      cachedResultName: 'Record Order',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        order_total: '={{ $json.body.payload.amount_dollars }}',
        discount_total: 0,
        tax_total: 0,
        shipping_total: 0,
        customer: '={{ $json.customer }}',
        currency_code: 'USD',
        lines: '={{ $json.lines}}',
        processed_at_foreign: '={{ $json.body.payload.created_at }}',
        financial_status: 'paid',
        fulfillment_status: 'shipped',
        id: '={{ $json.body.payload.id.toString() }}',
      },
      matchingColumns: [],
      schema: [
        {
          id: 'id',
          displayName: 'id',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'customer',
          displayName: 'customer',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'object',
        },
        {
          id: 'currency_code',
          displayName: 'currency_code',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'order_total',
          displayName: 'order_total',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'number',
        },
        {
          id: 'lines',
          displayName: 'lines',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'array',
        },
        {
          id: 'campaign_id',
          displayName: 'campaign_id',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'financial_status',
          displayName: 'financial_status',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'fulfillment_status',
          displayName: 'fulfillment_status',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'order_url',
          displayName: 'order_url',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'discount_total',
          displayName: 'discount_total',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'number',
        },
        {
          id: 'tax_total',
          displayName: 'tax_total',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'number',
        },
        {
          id: 'shipping_total',
          displayName: 'shipping_total',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'number',
        },
        {
          id: 'tracking_code',
          displayName: 'tracking_code',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'processed_at_foreign',
          displayName: 'processed_at_foreign',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'cancelled_at_foreign',
          displayName: 'cancelled_at_foreign',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'updated_at_foreign',
          displayName: 'updated_at_foreign',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'billing_address',
          displayName: 'billing_address',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'object',
          removed: true,
        },
        {
          id: 'promos',
          displayName: 'promos',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'array',
          removed: true,
        },
        {
          id: 'outreach',
          displayName: 'outreach',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'object',
          removed: true,
        },
        {
          id: 'tracking_number',
          displayName: 'tracking_number',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'tracking_carrier',
          displayName: 'tracking_carrier',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'tracking_url',
          displayName: 'tracking_url',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {},
  },
  {
    typeVersion: 1.2,
    position: [240, -40],
    id: '9da30f5b-c137-442c-8bb1-8f297dd0657f',
  }
);

// --- Respond to Webhook ---
const respond = createNode(
  'Respond to Webhook',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: {
      responseCode: 200,
    },
  },
  {
    typeVersion: 1.1,
    position: [460, -40],
    id: '3a657337-c759-4bcc-9653-e7043657522c',
  }
);

// --- Connections ---
const connections = [
  connect(webhook, editCustomer),
  connect(editCustomer, addLineItems),
  connect(addLineItems, saveOrder),
  connect(saveOrder, respond),
];

export default createWorkflow('Order Created', {
  nodes: [webhook, stickyNote, respond, editCustomer, addLineItems, saveOrder, stickyNote1],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
