import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Trigger ---
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample:
      '{\n  "id":"product id",\n  "title":"product title",\n  "handle":"product handle",\n  "url":"product url",\n  "description":"product description",\n  "type":"product type",\n  "image_url":"image url",\n  "publication_date":"publication date",\n  "variants": [\n    {\n      "id":"product id for variant",\n      "title":"title for variant",\n      "url": "url for variant",\n      "image_url":"image for variant",\n      "price": 100\n      \n    }\n  ]\n}',
  },
  {
    typeVersion: 1.1,
    position: [-420, -60],
    id: 'a56f85d8-9d80-4c0c-9f9f-43b41adc40d1',
  }
);

// --- Lookup Products (paginated Mailchimp API) ---
const lookupProducts = createNode(
  'Lookup Products',
  'n8n-nodes-base.httpRequest',
  {
    url: 'https://us9.api.mailchimp.com/3.0/ecommerce/stores/venn-factory-learning/products',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        {
          name: 'count',
          value: '10',
        },
      ],
    },
    options: {
      pagination: {
        pagination: {
          parameters: {
            parameters: [
              {
                name: 'offset',
                value: '={{ $pageCount * 10 }}',
              },
            ],
          },
          paginationCompleteWhen: 'other',
          completeExpression: '={{ $response.body.products.length < 10 }}',
          requestInterval: 1000,
        },
      },
    },
  },
  {
    typeVersion: 4.2,
    position: [-200, -160],
    id: 'cc59da75-a071-4803-a91b-2e328daf9b6c',
    credentials: {
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
    },
  }
);
lookupProducts.executeOnce = true;
lookupProducts.retryOnFail = true;

// --- Split Out ---
const splitOut = createNode(
  'Split Out',
  'n8n-nodes-base.splitOut',
  {
    fieldToSplitOut: 'products',
    include: '=',
    options: {},
  },
  {
    typeVersion: 1,
    position: [20, -160],
    id: '0aa89443-dbe9-45b2-b0c7-ad28e251ee36',
  }
);
splitOut.alwaysOutputData = true;

// --- Tag Mailchimp Records ---
const tagMailchimp = createNode(
  'Tag Mailchimp Records',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'bccdd17d-f156-4969-99a5-14eb81456e17',
          name: 'mailchimp',
          value: '={{ $json }}',
          type: 'object',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [240, -160],
    id: '4e1e8860-524f-4b8d-b03a-401136c44e54',
  }
);

// --- Tag Incoming Records ---
const tagIncoming = createNode(
  'Tag Incoming Records',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'f9c598de-fc24-46a9-bfc3-6f470bf773dc',
          name: 'incoming',
          value: '={{ $json }}',
          type: 'object',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [240, 40],
    id: '1f1e9628-03f0-403e-a85f-934d1b02fd2d',
  }
);

// --- Merge ---
const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    advanced: true,
    mergeByFields: {
      values: [
        {
          field1: 'mailchimp.products.id',
          field2: 'incoming.id',
        },
      ],
    },
    joinMode: 'keepEverything',
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [460, -60],
    id: '7636e005-3349-4354-85fa-b37124930a1b',
  }
);

// --- Determine Operation (Code) ---
const determineOp = createNode(
  'Determine Operation',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode:
      "let operation = 'noop';\n\nif ($input.item.json.hasOwnProperty('mailchimp')) {\n  if ($input.item.json.hasOwnProperty('incoming')) {\n   operation = 'update'\n  }\n}\nelse if ($input.item.json.hasOwnProperty('incoming')) {\n  operation = 'create';\n}\n\n$input.item.json.operation = operation;\n\nreturn $input.item;",
  },
  {
    typeVersion: 2,
    position: [680, -60],
    id: 'd938bb12-3221-4bc4-8ca0-cfe7da2bf1c4',
  }
);

// --- Route Operation (Switch) ---
const routeOp = createNode(
  'Route Operation',
  'n8n-nodes-base.switch',
  {
    rules: {
      values: [
        {
          conditions: {
            options: {
              caseSensitive: true,
              leftValue: '',
              typeValidation: 'strict',
              version: 2,
            },
            conditions: [
              {
                leftValue: '={{ $json.operation }}',
                rightValue: 'create',
                operator: {
                  type: 'string',
                  operation: 'equals',
                },
                id: 'a7afd3ca-e556-4458-b013-2024d656d0f2',
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Create',
        },
        {
          conditions: {
            options: {
              caseSensitive: true,
              leftValue: '',
              typeValidation: 'strict',
              version: 2,
            },
            conditions: [
              {
                id: 'dc77c6c0-9e87-469f-a2ed-1222fc99db95',
                leftValue: '={{ $json.operation }}',
                rightValue: 'update',
                operator: {
                  type: 'string',
                  operation: 'equals',
                  name: 'filter.operator.equals',
                },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Update',
        },
        {
          conditions: {
            options: {
              caseSensitive: true,
              leftValue: '',
              typeValidation: 'strict',
              version: 2,
            },
            conditions: [
              {
                id: 'e6231406-2136-4c04-9f93-3bc4c8397397',
                leftValue: '={{ $json.operation }}',
                rightValue: 'noop',
                operator: {
                  type: 'string',
                  operation: 'equals',
                  name: 'filter.operator.equals',
                },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'No Operation',
        },
      ],
    },
    options: {
      fallbackOutput: 'none',
    },
  },
  {
    typeVersion: 3.2,
    position: [900, -60],
    id: 'c9c7e64a-4588-4a32-b7cf-a20a4f6f72a2',
  }
);

// --- Filter (check if update needed) ---
const filter = createNode(
  'Filter',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: '94562b1f-7add-45f1-9b93-eae139b549e2',
          leftValue: '={{ $json.mailchimp.products.title }}',
          rightValue: '={{ $json.incoming.title }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: '81e6eae5-1af2-4fc8-8ccf-de29a84f81ac',
          leftValue: '={{ $json.mailchimp.products.url }}',
          rightValue: '={{ $json.incoming.url }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: '30fc6651-4d64-4ce1-bf27-d78bbcf876bc',
          leftValue: '={{ $json.incoming.description }}',
          rightValue: '={{ $json.mailchimp.products.description }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: '93af9078-b225-4d77-88a3-f5cd17a241dd',
          leftValue: '={{ $json.mailchimp.products.image_url }}',
          rightValue: '={{ $json.incoming.image_url }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: '5a0ba899-d8f3-419d-9fe5-d9c603efef97',
          leftValue: '={{ $json.mailchimp.products.variants[0].price }}',
          rightValue: '={{ $json.incoming.variants[0].price }}',
          operator: {
            type: 'number',
            operation: 'notEquals',
          },
        },
      ],
      combinator: 'or',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1120, -60],
    id: '71053cfd-885f-4877-b4ad-90f5cb46a2c7',
  }
);

// --- Create Product (HTTP POST) ---
const createProduct = createNode(
  'Create Product',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://us9.api.mailchimp.com/3.0/ecommerce/stores/venn-factory-learning/products',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendBody: true,
    bodyParameters: {
      parameters: [
        { name: 'store_id', value: 'venn-factory-learning' },
        { name: 'id', value: '={{ $json.incoming.id }}' },
        { name: 'title', value: '={{ $json.incoming.title }}' },
        { name: 'variants', value: '={{ $json.incoming.variants }}' },
        { name: 'handle', value: '={{ $json.incoming.handle }}' },
        { name: 'url', value: '={{ $json.incoming.url }}' },
        { name: 'description', value: '={{ $json.incoming.description }}' },
        { name: 'type', value: '={{ $json.incoming.type }}' },
        { name: 'image_url', value: '={{ $json.incoming.image_url }}' },
        {
          name: 'published_at_foreign',
          value: '={{ $json.incoming.publication_date }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [1560, -260],
    id: '97e83aea-fc84-4456-9594-a833fdf75e89',
    credentials: {
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
    },
  }
);
createProduct.retryOnFail = true;

// --- Update Product (HTTP PATCH) ---
const updateProduct = createNode(
  'Update Product',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://us9.api.mailchimp.com/3.0/ecommerce/stores/venn-factory-learning/products/{{ $json.incoming.id }}',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpBasicAuth',
    sendBody: true,
    bodyParameters: {
      parameters: [
        { name: 'store_id', value: 'venn-factory-learning' },
        { name: 'id', value: '={{ $json.incoming.id }}' },
        { name: 'title', value: '={{ $json.incoming.title }}' },
        { name: 'variants', value: '={{ $json.incoming.variants }}' },
        { name: 'handle', value: '={{ $json.incoming.handle }}' },
        { name: 'url', value: '={{ $json.incoming.url }}' },
        { name: 'description', value: '={{ $json.incoming.description }}' },
        { name: 'type', value: '={{ $json.incoming.type }}' },
        { name: 'image_url', value: '={{ $json.incoming.image_url }}' },
        {
          name: 'published_at_foreign',
          value: '={{ $json.incoming.publication_date }}',
        },
      ],
    },
    options: {
      batching: {
        batch: {
          batchSize: 5,
        },
      },
    },
  },
  {
    typeVersion: 4.2,
    position: [1560, -60],
    id: 'de41c0bb-94ee-49ec-b84c-a9a3adcec583',
    credentials: {
      httpBasicAuth: {
        id: 'wz1MG3unrTX7XIXF',
        name: 'Mailchimp Basic Auth',
      },
    },
  }
);
updateProduct.retryOnFail = true;

// --- No Operation ---
const noOp = createNode(
  'No Operation, do nothing',
  'n8n-nodes-base.noOp',
  {},
  {
    typeVersion: 1,
    position: [1560, 140],
    id: '857fda9f-1762-468c-b706-8cb0bd94fa33',
  }
);

// --- Connections ---
const connections = [
  // Trigger fans out to Lookup Products and Tag Incoming Records
  connect(trigger, lookupProducts),
  connect(trigger, tagIncoming),
  // Lookup path
  connect(lookupProducts, splitOut),
  connect(splitOut, tagMailchimp),
  // Both paths merge
  connect(tagMailchimp, merge, 0, 0),
  connect(tagIncoming, merge, 0, 1),
  // Merge → Determine → Route
  connect(merge, determineOp),
  connect(determineOp, routeOp),
  // Route outputs: 0=Create, 1=Update(via Filter), 2=NoOp
  connect(routeOp, createProduct, 0),
  connect(routeOp, filter, 1),
  connect(routeOp, noOp, 2),
  // Filter → Update
  connect(filter, updateProduct),
];

export default createWorkflow('Create or Update Product', {
  nodes: [
    trigger,
    createProduct,
    lookupProducts,
    tagMailchimp,
    splitOut,
    tagIncoming,
    merge,
    determineOp,
    routeOp,
    updateProduct,
    noOp,
    filter,
  ],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
