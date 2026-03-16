import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const webhook = createNode('Product Created', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: '5c9181f3-e40b-4e2c-b825-afed739f6861',
  responseMode: 'lastNode',
  options: {},
}, {
  typeVersion: 2,
  position: [-220, -100],
  id: '9af1013f-0618-47fa-9f08-bfff22f13514',
});
webhook.webhookId = '5c9181f3-e40b-4e2c-b825-afed739f6861';

const executeWorkflow = createNode('Update Notion and Mailchimp', 'n8n-nodes-base.executeWorkflow', {
  workflowId: {
    __rl: true,
    value: 'cOKfx1Z78zrQXc5A',
    mode: 'list',
    cachedResultName: 'Copy Products To Webflow and Mailchimp',
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
}, {
  typeVersion: 1.2,
  position: [0, -100],
  id: '9c65beec-efeb-4d90-9960-872383591d0b',
});

export default createWorkflow('Product Created', {
  nodes: [webhook, executeWorkflow],
  connections: [connect(webhook, executeWorkflow)],
  settings: { executionOrder: 'v1' },
});
