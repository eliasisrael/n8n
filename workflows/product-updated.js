import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const webhook = createNode('Product Updated', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: '67a6b559-356d-48ae-9fc2-95d74995e32b',
  responseMode: 'lastNode',
  options: {},
}, {
  typeVersion: 2,
  position: [-500, -420],
  id: '0743abe0-4e58-4096-b6c5-5d2efce15a44',
});
webhook.webhookId = '67a6b559-356d-48ae-9fc2-95d74995e32b';

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
  position: [-280, -420],
  id: 'b7921437-b887-40e2-837c-1c326a270be4',
});

export default createWorkflow('Product Updated', {
  nodes: [webhook, executeWorkflow],
  connections: [connect(webhook, executeWorkflow)],
  settings: { executionOrder: 'v1' },
});
