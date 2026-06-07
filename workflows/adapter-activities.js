import { createAdapter } from '../lib/adapter-template.js';

// The activity-webhook sub-workflow will be created separately.
// Its workflow ID will need to be updated here after it's pushed to the server.
export default createAdapter({
  name: 'Adapter: Activities',
  webhookPath: 'adapter-activities',
  targets: [
    { name: 'Execute Activity Webhook', workflowId: 'jtVgZQQrZpfUf7IR' },
  ],
  noticeEvents: [
    { type: 'data_source.schema_updated', message: 'Activities database schema was changed in Notion. Review the schema and update workflows if needed.' },
  ],
});
