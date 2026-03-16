import { createWorkflow, createNode } from '../lib/workflow.js';

const webhook = createNode('Product Deleted', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: '322d59b3-8d82-4a5c-ae8f-b0446976192a',
  options: {},
}, {
  typeVersion: 2,
  position: [0, 0],
  id: '69fadcb9-7193-4df8-8821-a7484364690b',
});
webhook.webhookId = '322d59b3-8d82-4a5c-ae8f-b0446976192a';

export default createWorkflow('Product Deleted', {
  nodes: [webhook],
  connections: [],
  settings: { executionOrder: 'v1' },
});
