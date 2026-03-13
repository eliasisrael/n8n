import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Sales Pipeline',
  webhookPath: 'adapter-sales-pipeline',
  targets: [
    { name: 'Execute Close Stale Task', workflowId: 'EIkTeuoWsQ6fAgNO' },
    { name: 'Execute Stage Entry Tasks', workflowId: 'MXmnk2bPGxMn8ROL' },
  ],
});
