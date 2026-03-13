import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Clients',
  webhookPath: 'adapter-clients',
  targets: [
    { name: 'Execute Clients Workflow', workflowId: 'GMNBwXAkFWc7XhlG' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Logo', value: '={{ $json.property_logo }}', type: 'array' },
    { name: 'Notes', value: '={{ $json.property_notes }}', type: 'array' },
    { name: 'TZ', value: '={{ $json.property_tz }}' },
    { name: 'Last edited time', value: '={{ $json.property_last_edited_time }}' },
    { name: 'List on site?', value: '={{ $json.property_list_on_site }}', type: 'boolean' },
    { name: 'HQ', value: '={{ $json.property_hq }}' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Site', value: '={{ $json.property_site }}' },
    { name: 'Master contacts', value: '={{ $json.property_master_contacts }}', type: 'array' },
  ],
});
