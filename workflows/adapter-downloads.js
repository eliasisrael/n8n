import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Downloads',
  webhookPath: 'adapter-downloads',
  targets: [
    { name: 'Execute Downloads Workflow', workflowId: 'oPFK3KGX1tTItJHt' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Thumbnail', value: '={{ $json.property_thumbnail }}' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Bullet 1', value: '={{ $json.property_bullet_1 }}' },
    { name: 'Bullet 2', value: '={{ $json.property_bullet_2 }}' },
    { name: 'Bullet 3', value: '={{ $json.property_bullet_3 }}' },
    { name: 'Visible', value: '={{ $json.property_visible }}' },
    { name: 'Description', value: '={{ $json.property_description }}' },
    { name: 'Title', value: '={{ $json.property_title }}' },
    { name: 'Publication Date', value: '={{ $json.property_publication_date }}' },
    { name: 'Download File', value: '={{ $json.property_download_file }}' },
  ],
});
