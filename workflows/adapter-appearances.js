import { createAdapter } from '../lib/adapter-template.js';

// Appearances DB (35d10c83-...) — this adapter handles the Appearances Workflow only.
// The Comms pipeline subscribers (CST + SET) are handled by adapter-comms-pipeline.js,
// which is also registered in the same QStash topic.
export default createAdapter({
  name: 'Adapter: Appearances',
  webhookPath: 'adapter-appearances',
  targets: [
    { name: 'Execute Appearances Workflow', workflowId: 'ceyZMOF8SKTkilhd' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Priority', value: '={{ $json.property_priority }}' },
    { name: 'Status', value: '={{ $json.property_status }}' },
    { name: 'Publication window', value: '={{ $json.property_publication_window }}' },
    { name: 'Master contacts', value: '={{ $json.property_master_contacts }}' },
    { name: 'Location', value: '={{ $json.property_location }}' },
    { name: 'Delivery date', value: '={{ $json.property_delivery_date }}' },
    { name: 'Comms type', value: '={{ $json.property_comms_type }}' },
    { name: 'Post-event description', value: '={{ $json.property_post_event_description }}' },
    { name: 'Public?', value: '={{ $json.property_public }}' },
    { name: 'Added', value: '={{ $json.property_added }}' },
    { name: 'Sticky', value: '={{ $json.property_sticky }}' },
    { name: 'Event name', value: '={{ $json.property_event_name }}' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Tasks', value: '={{ $json.property_tasks }}' },
    { name: 'Pre-event description', value: '={{ $json.property_pre_event_description }}' },
    { name: 'Shareable Link', value: '={{ $json.property_shareable_link }}' },
    { name: 'Name', value: '={{ $json.property_name }}' },
    { name: 'Event image', value: '={{ $json.property_event_image }}' },
  ],
});
