import { createAdapter } from '../lib/adapter-template.js';

export default createAdapter({
  name: 'Adapter: Contacts',
  webhookPath: 'adapter-contacts',
  targets: [
    { name: 'Execute Contacts Workflow', workflowId: 'XfO5Zg1zn6A4vhD6' },
  ],
  fieldMappings: [
    { name: 'id', value: '={{ $json.id }}' },
    { name: 'Name', value: '={{ $json.name }}' },
    { name: 'Papers', value: '={{ $json.property_papers }}' },
    { name: 'Birthday', value: '={{ $json.property_birthday }}' },
    { name: 'Contact form msg', value: '={{ $json.property_contact_form_msg }}' },
    { name: 'Country', value: '={{ $json.property_country }}' },
    { name: 'Client DB', value: '={{ $json.property_client_db }}' },
    { name: 'Last name', value: '={{ $json.property_last_name }}' },
    { name: 'Street address', value: '={{ $json.property_street_address }}' },
    { name: 'Company Name', value: '={{ $json.property_company_name }}' },
    { name: 'Phone', value: '={{ $json.property_phone }}' },
    { name: 'Address line 2', value: '={{ $json.property_address_line_2 }}' },
    { name: 'Email Marketing', value: '={{ $json.property_email_marketing }}' },
    { name: 'City', value: '={{ $json.property_city }}' },
    { name: 'Email', value: '={{ $json.property_email }}' },
    { name: 'Postal code', value: '={{ $json.property_postal_code }}' },
    { name: 'First name', value: '={{ $json.property_first_name }}' },
    { name: 'State', value: '={{ $json.property_state }}' },
    { name: 'Identifier', value: '={{ $json.property_identifier }}' },
    { name: 'Tags', value: '={{ $json.property_tags }}' },
  ],
});
