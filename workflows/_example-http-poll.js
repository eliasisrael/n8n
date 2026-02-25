/**
 * Example workflow: polls an HTTP endpoint on a schedule.
 * Prefixed with _ so it's clearly an example — delete or rename when not needed.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const trigger = createNode('Schedule Trigger', 'n8n-nodes-base.scheduleTrigger', {
  rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
});

const http = createNode('HTTP Request', 'n8n-nodes-base.httpRequest', {
  url: 'https://httpbin.org/get',
  method: 'GET',
});

export default createWorkflow('Example: HTTP Poll', {
  nodes: [trigger, http],
  connections: [connect(trigger, http)],
});
