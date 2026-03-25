import { createAdapter } from '../lib/adapter-template.js';

// Both sub-workflows use inputSource: 'jsonExample' with { body, record } shape,
// so they need explicit workflowInputs to receive data.
const BODY_RECORD_INPUTS = {
  mappingMode: 'defineBelow',
  value: {
    'body': '={{ $json.body }}',
    'record': '={{ $json.record }}',
  },
  matchingColumns: [],
  schema: [
    { id: 'body', displayName: 'body', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
    { id: 'record', displayName: 'record', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
  ],
  attemptToConvertTypes: false,
  convertFieldsToString: true,
};

export default createAdapter({
  name: 'Adapter: Sales Pipeline',
  webhookPath: 'adapter-sales-pipeline',
  targets: [
    { name: 'Execute Close Stale Task', workflowId: 'EIkTeuoWsQ6fAgNO', workflowInputs: BODY_RECORD_INPUTS },
    { name: 'Execute Stage Entry Tasks', workflowId: 'MXmnk2bPGxMn8ROL', workflowInputs: BODY_RECORD_INPUTS },
  ],
});
