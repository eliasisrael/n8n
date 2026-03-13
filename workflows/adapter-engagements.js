import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Engagements',
  webhookPath: 'adapter-engagements',
  targets: [
    { name: 'Execute Engagements Workflow', workflowId: '0VlE1zFPDaz94blF' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Notes', value: '={{ $json.property_notes }}' },
    { name: 'Cycle payment', value: '={{ $json.property_cycle_payment }}', type: 'number' },
    { name: 'Currency', value: '={{ $json.property_currency }}' },
    { name: 'Due at end', value: '={{ $json.property_due_at_end }}', type: 'number' },
    { name: 'Cycle count', value: '={{ $json.property_cycle_count }}', type: 'number' },
    { name: 'Due at start', value: '={{ $json.property_due_at_start }}', type: 'number' },
    { name: 'Client db', value: '={{ $json.property_client_db }}', type: 'array' },
    { name: 'Sales pipeline', value: '={{ $json.property_sales_pipeline }}', type: 'array' },
    { name: 'Engagement start&end', value: '={{ $json.property_engagement_start_end }}', type: 'object' },
    { name: 'Payment terms', value: '={{ $json.property_payment_terms }}' },
    { name: 'Cycle length', value: '={{ $json.property_cycle_length }}' },
  ],
});
