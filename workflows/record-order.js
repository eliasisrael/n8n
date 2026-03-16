import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: '{\n  "id":"string",\n  "customer": {\n    "id": "someone@example.com",\n    "email_adress": "someone@example.com",\n    "opt_in_status": true,\n    "company": "company name",\n    "first_name": "sam",\n    "last_name": "houston",\n    "address": {\n      "address1": "123 main st",\n      "address2": "ste 100",\n      "city": "anytown",\n      "province": "texas",\n      "postal_code": "75019",\n      "country": "US of F\'in A",\n      "country_code": "US"\n    }\n  },\n  "currency_code": "USD",\n  "order_total":100.00,\n  "lines": [\n    {\n      "id": "line id",\n      "product_id": "product",\n      "product_variant_id": "variant",\n      "quantity": 1,\n      "price": 100.00,\n      "discount": 0\n    }\n  ],\n  "campaign_id": "campaign",\n  "financial_status": "paid|pending|refunded|cancelled",\n  "fulfillment_status": "paid|pending|refunded|cancelled",\n  "order_url": "URL",\n  "discount_total": 0.0,\n  "tax_total": 3.50,\n  "shipping_total": 0.0,\n  "tracking_code": "none",\n  "processed_at_foreign": "iso date",\n  "cancelled_at_foreign": "iso date",\n  "updated_at_foreign": "iso date",\n  "billing_address": {\n    "name": "address nickname",\n    "address1": "123 Main st",\n    "address2": "STE 100",\n    "city": "anytown",\n    "province": "Texas",\n    "province_code": "TX",\n    "postal_code": "75019",\n    "country": "United States",\n    "country_code": "US",\n    "longitude": 99.4,\n    "latitude": -87.3,\n    "phone": "479 332 1953",\n    "company": "Hawaii Moving Company"\n  },\n  "promos": [\n    {\n      "code": "promo code",\n      "amount_discounted": 0.0,\n      "type": "fixed|percentage"\n    }\n  ],\n  "outreach": {\n    "id": "outreach id"\n  },\n  "tracking_number": "1Z234o023432",\n  "tracking_carrier": "UPS",\n  "tracking_url": "https://usp.com/tracking/234234234234" \n}',
  },
  {
    typeVersion: 1.1,
    position: [0, 0],
    id: 'db85d9ac-ca78-4e68-8618-668fbabfd820',
  },
);

const addStoreId = createNode(
  'Add Store ID',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '01d57e72-57f6-4508-b13d-075acb37a5d5',
          name: 'store_id',
          value: 'venn-factory-learning',
          type: 'string',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [220, 0],
    id: '23be5b19-5be9-43b1-969b-aff32b329ead',
  },
);

const postOrder = createNode(
  'Post Order to Mailchimp',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: '=https://us9.api.mailchimp.com/3.0/ecommerce/stores/{{$json.store_id}}/orders',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendBody: true,
    bodyParameters: {
      parameters: [
        { name: 'customer', value: '={{ $json.customer }}' },
        { name: '=currency_code', value: '={{ $json.currency_code || \'USD\' }}' },
        { name: 'order_total', value: '={{ $json.order_total || 0 }}' },
        { name: 'lines', value: '={{ $json.lines }}' },
        { name: 'discount_total', value: '={{ $json.discount_total || 0 }}' },
        { name: 'tax_total', value: '={{ $json.tax_total || 0 }}' },
        { name: 'shipping_total', value: '={{ $json.shipping_total || 0 }}' },
        { name: 'processed_at_foreign', value: '={{ $json.processed_at_foreign || new Date().toISOString() }}' },
        { name: 'id', value: '={{ $json.id }}' },
      ],
    },
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [440, 0],
    id: '620a20c8-262a-484c-aeaf-c50b324646cb',
    credentials: {
      httpBasicAuth: { id: 'wz1MG3unrTX7XIXF', name: 'Mailchimp Basic Auth' },
    },
  },
);
postOrder.retryOnFail = true;

export default createWorkflow('Record Order', {
  nodes: [trigger, addStoreId, postOrder],
  connections: [
    connect(trigger, addStoreId),
    connect(addStoreId, postOrder),
  ],
  settings: { executionOrder: 'v1' },
});
