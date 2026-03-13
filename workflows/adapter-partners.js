import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Partners',
  webhookPath: 'adapter-partners',
  targets: [
    { name: 'Execute Partners Workflow', workflowId: 'G5JpSIFZSBNVM8RR' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Logo', value: '={{ $json.property_logo }}', type: 'array' },
    { name: 'Notes', value: '={{ $json.property_notes }}' },
    { name: 'Last edited time', value: '={{ $json.property_last_edited_time }}' },
    { name: 'List on site?', value: '={{ $json.property_list_on_site }}', type: 'boolean' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Site', value: '={{ $json.property_site }}' },
    { name: 'Start date', value: '={{ $json.property_start_date }}', type: 'object' },
  ],
});
