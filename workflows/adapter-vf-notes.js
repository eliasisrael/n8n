import { createAdapter } from '../lib/adapter-template.js';

// The vf-notes-webhook sub-workflow will be created separately.
// Its workflow ID will need to be updated here after it's pushed to the server.
export default createAdapter({
  name: 'Adapter: VF Notes',
  webhookPath: 'adapter-vf-notes',
  targets: [
    { name: 'Execute VF Notes Webhook', workflowId: '2A5i4HBS7UzZ1VwY' },
  ],
  noticeEvents: [
    { type: 'data_source.schema_updated', message: 'VF Notes database schema was changed in Notion. Review the schema and update workflows if needed.' },
  ],
});
