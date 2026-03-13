import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Partner Pipeline',
  webhookPath: 'adapter-partner-pipeline',
  targets: [
    { name: 'Execute Close Stale Task', workflowId: 'EIkTeuoWsQ6fAgNO' },
    { name: 'Execute Stage Entry Tasks', workflowId: 'MXmnk2bPGxMn8ROL' },
  ],
});
