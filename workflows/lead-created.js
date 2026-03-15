import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Webhook ---
const webhook = createNode(
  'Webhook',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: '080d234f-f3f9-4d30-81b1-51c616d346a1',
    options: {},
  },
  {
    typeVersion: 2,
    position: [-320, -208],
    id: '39abe1c6-a77c-4efb-972d-fb93aa1131cd',
  }
);
webhook.webhookId = '080d234f-f3f9-4d30-81b1-51c616d346a1';

// --- Validate Email ---
const validateEmail = createNode(
  'Validate Email',
  'n8n-nodes-base.httpRequest',
  {
    url: '=https://api.usercheck.com/email/{{ encodeURI($json.body.payload.email) }}',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendQuery: true,
    queryParameters: {
      parameters: [{}],
    },
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [-96, -128],
    id: '49bfcf98-7c18-47e4-8160-4b1f6b9628bf',
    credentials: {
      httpHeaderAuth: {
        id: 'sGklpGDze5oWu3MF',
        name: 'UserCheck API',
      },
    },
  }
);
validateEmail.retryOnFail = true;
validateEmail.onError = 'continueErrorOutput';

// --- No Operation, do nothing ---
const noOp = createNode(
  'No Operation, do nothing',
  'n8n-nodes-base.noOp',
  {},
  {
    typeVersion: 1,
    position: [128, -32],
    id: 'e0ba327c-7bea-47c6-995c-539b96eeae71',
  }
);

// --- Not Spam (Filter) ---
const notSpam = createNode(
  'Not Spam',
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
          id: 'd4f042e2-cfe8-4ecc-979e-5886192b68f0',
          leftValue: '={{ $json.mx }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        },
        {
          id: 'c9361d08-e12a-4926-ac93-d69bc32e7427',
          leftValue: '={{ $json.spam }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'false',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [128, -224],
    id: '877cb729-6844-40f7-86f3-b937bb5a3254',
  }
);

// --- Merge ---
const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    advanced: true,
    mergeByFields: {
      values: [
        {
          field1: 'body.payload.email',
          field2: 'email',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [352, -304],
    id: 'd237b3ac-ee3e-4c1a-a220-81d783ad91b3',
  }
);

// --- Call 'Notion Master Contact Upsert' ---
const callUpsert = createNode(
  "Call 'Notion Master Contact Upsert'",
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: 'EnwxsZaLNrYqKBDa',
      mode: 'list',
      cachedResultUrl: '/workflow/EnwxsZaLNrYqKBDa',
      cachedResultName: 'Notion Master Contact Upsert',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        email: '={{ $json.normalized_email }}',
        first_name: '={{ $json.body.payload.first_name }}',
        last_name: '={{ $json.body.payload.last_name }}',
        email_marketing:
          "={{ $json.body.payload.subscribed? 'subscribed':'unsubscribed' }}",
      },
      matchingColumns: [],
      schema: [
        {
          id: 'email',
          displayName: 'email',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'first_name',
          displayName: 'first_name',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'last_name',
          displayName: 'last_name',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'company',
          displayName: 'company',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'email_marketing',
          displayName: 'email_marketing',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'tags',
          displayName: 'tags',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'array',
          removed: true,
        },
        {
          id: 'street_address',
          displayName: 'street_address',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'street_address_2',
          displayName: 'street_address_2',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'city',
          displayName: 'city',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'state',
          displayName: 'state',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'postal_code',
          displayName: 'postal_code',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'country',
          displayName: 'country',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: true,
        },
        {
          id: 'phone',
          displayName: 'phone',
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
    position: [560, -304],
    id: '6d71ac7f-331c-402e-8a93-a46af691b0ab',
  }
);

// --- Connections ---
const connections = [
  // Webhook fans out to Validate Email and Merge input 0
  connect(webhook, validateEmail),
  connect(webhook, merge, 0, 0),
  // Validate Email output 0 (success) → Not Spam
  connect(validateEmail, notSpam, 0),
  // Validate Email output 1 (error) → No Operation
  connect(validateEmail, noOp, 1),
  // Not Spam → Merge input 1
  connect(notSpam, merge, 0, 1),
  // Merge → Call Upsert
  connect(merge, callUpsert),
];

export default createWorkflow('Lead Created', {
  nodes: [webhook, validateEmail, noOp, notSpam, merge, callUpsert],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
