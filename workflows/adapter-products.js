import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Products',
  webhookPath: 'adapter-products',
  targets: [
    { name: 'Execute Products Workflow', workflowId: 'MFoTZac1zXBHGdc5' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Title', value: '={{ $json.name }}' },
    { name: 'Description (250 chars)', value: '={{ $json.property_description_250_chars }}' },
    { name: 'Download Image', value: '={{ $json.property_download_image[0] }}' },
    { name: 'Tag', value: '={{ $json.property_tag }}' },
    { name: 'Thinkific Category', value: '={{ $json.property_thinkific_category }}' },
    { name: 'Thinkific Type', value: '={{ $json.property_thinkific_type }}' },
    { name: 'Release Date', value: '={{ $json.property_release_date }}', type: 'object' },
    { name: 'Price', value: '={{ $json.property_price }}', type: 'number' },
    { name: 'Store Product Link', value: '={{ $json.property_store_product_link }}' },
    { name: 'Visible', value: '={{ $json.property_visible }}', type: 'boolean' },
    { name: 'Webflow ID', value: '={{ $json.property_webflow_id }}' },
    { name: 'Product Abstract', value: '={{ $json.property_product_abstract }}' },
    { name: "You'll Learn (Benefit 1)", value: '={{ $json.property_you_ll_learn_benefit_1 }}' },
    { name: "You'll Learn (Benefit 2)", value: '={{ $json.property_you_ll_learn_benefit_2 }}' },
    { name: "You'll Learn (Benefit 3)", value: '={{ $json.property_you_ll_learn_benefit_3 }}' },
    { name: 'LMS_ID', value: '={{ $json.property_thinkific_id }}' },
  ],
});
