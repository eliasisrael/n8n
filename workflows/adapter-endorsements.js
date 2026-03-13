import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Book Endorsements',
  webhookPath: 'adapter-endorsements',
  targets: [
    { name: 'Store Book Endorsement', workflowId: 'gmtPuFBhZ56ImCcX' },
  ],
  fieldMappings: [
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Endorser Name', value: '={{ $json.property_name }}' },
    { name: 'Endorser Title', value: '={{ $json.property_title }}' },
    { name: 'Organization', value: '={{ $json.property_affiliation }}' },
    { name: 'Endorsement Body', value: '={{ $json.property_endorsement }}' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Approved', value: '={{ $json.property_approved }}' },
    { name: 'Spotlight', value: '={{ $json.property_spotlight }}' },
    { name: 'NotionId', value: '={{ $json.id }}' },
    { name: 'Endorser Title 2', value: '={{ $json.property_title_2 }}' },
    { name: 'Organization 2', value: '={{ $json.property_affiliation_2 }}' },
  ],
});
