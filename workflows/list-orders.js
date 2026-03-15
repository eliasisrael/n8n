import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Manual Trigger ---
const trigger = createNode(
  "When clicking \u2018Test workflow\u2019",
  'n8n-nodes-base.manualTrigger',
  {},
  {
    typeVersion: 1,
    position: [0, 0],
    id: 'c86403a2-bb14-4881-8509-e22068038c60',
  }
);

// --- HTTP Request (List Orders) ---
const httpRequest = createNode(
  'HTTP Request',
  'n8n-nodes-base.httpRequest',
  {
    url: '=https://us9.api.mailchimp.com/3.0/ecommerce/orders',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [224, 0],
    id: 'a52ebf0e-eda3-493b-a25c-1ad38d0c7430',
    credentials: {
      httpHeaderAuth: {
        id: 'sGklpGDze5oWu3MF',
        name: 'UserCheck API',
      },
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
      mailchimpOAuth2Api: {
        id: 'DtyHZOOulvefkbC3',
        name: 'Mailchimp account',
      },
    },
  }
);

// --- Connections ---
const connections = [connect(trigger, httpRequest)];

export default createWorkflow('List Orders', {
  nodes: [trigger, httpRequest],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
