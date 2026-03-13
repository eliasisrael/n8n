import { createAdapter } from '../lib/adapter-template.js';

// Comms pipeline events arrive via the Appearances DB (35d10c83-...).
// This adapter handles Close Stale Task + Stage Entry Tasks, which expect
// the { body, record } format. The Appearances Workflow is handled by
// adapter-appearances.js (which uses flattened field mappings).
// Both adapters are registered in the same QStash topic (notion-appearances).
export default createAdapter({
  name: 'Adapter: Comms Pipeline',
  webhookPath: 'adapter-comms-pipeline',
  targets: [
    { name: 'Execute Close Stale Task', workflowId: 'EIkTeuoWsQ6fAgNO' },
    { name: 'Execute Stage Entry Tasks', workflowId: 'MXmnk2bPGxMn8ROL' },
  ],
  // No fieldMappings — uses default { body, record } format for CST/SET
});
