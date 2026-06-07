import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Partner Pipeline',
  webhookPath: 'adapter-partner-pipeline',
  targets: [
    { name: 'Execute Close Stale Task', workflowId: 'EIkTeuoWsQ6fAgNO' },
    { name: 'Execute Stage Entry Tasks', workflowId: 'MXmnk2bPGxMn8ROL' },
  ],
  noticeEvents: [
    { type: 'data_source.schema_updated', message: 'Partner Pipeline database schema was changed in Notion. Review the schema and update workflows if needed.' },
  ],
});
