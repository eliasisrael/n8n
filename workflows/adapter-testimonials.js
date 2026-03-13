import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Testimonials',
  webhookPath: 'adapter-testimonials',
  targets: [
    { name: 'Execute Testimonials Workflow', workflowId: 'YlSBvDkZLHocJCjU' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.property_name }}' },
    { name: 'Logo', value: '={{ $json.property_logo }}' },
    { name: 'Last edited time', value: '={{ $json.property_last_edited_time }}' },
    { name: 'WebflowId', value: '={{ $json.property_webflow_id }}' },
    { name: 'Original testimonial', value: '={{ $json.property_original_testimonial }}' },
    { name: 'Date', value: '={{ $json.property_date }}' },
    { name: 'Approved?', value: '={{ $json.property_approved }}' },
    { name: 'Headshot', value: '={{ $json.property_headshot }}' },
    { name: 'Affiliation', value: '={{ $json.property_affiliation }}' },
    { name: 'Non-public name', value: '={{ $json.property_non_public_name }}' },
    { name: 'Succcess stories in STAR form', value: '={{ $json.property_success_stories_in_star_form }}' },
    { name: 'Testimonial', value: '={{ $json.property_testimonial }}' },
    { name: 'Testimonial record', value: '={{ $json.property_testimonial_record }}' },
  ],
});
