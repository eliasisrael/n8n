import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Execute Workflow Trigger ---
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    workflowInputs: {
      values: [
        { name: 'title' },
        { name: 'thumbnail' },
        { name: 'description' },
        { name: 'product_type' },
        { name: 'release_date' },
        { name: 'price', type: 'number' },
        { name: 'product_page_link' },
        { name: 'lms_id' },
        { name: 'visible', type: 'boolean' },
        { name: 'product_categories', type: 'array' },
      ],
    },
  },
  {
    typeVersion: 1.1,
    position: [-100, -720],
    id: 'b209cf51-4f09-4e7a-a185-4f2dfb2a8ef7',
  }
);

// --- Fix Product Type Capitalization ---
const fixProductType = createNode(
  'Fix Product Type Capitalization',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '4df388b2-14f8-4aef-ab37-3825b4b987f2',
          name: 'product_type',
          value: "={{ $json.product_type.split('_').map(x => x[0].toUpperCase() + x.substr(1).toLowerCase()).join(' ') }}",
          type: 'string',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [120, -820],
    id: '9a56ce6e-2881-4ce0-b409-3384c679c015',
  }
);

// --- Get Products from Notion ---
const getProducts = createNode(
  'Get Products from Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: '1d48ebaf-15ee-80c4-a8e7-d99c0596d520',
      mode: 'list',
      cachedResultName: 'Web DB: Products',
      cachedResultUrl: 'https://www.notion.so/1d48ebaf15ee80c4a8e7d99c0596d520',
    },
    returnAll: true,
    filterType: 'manual',
    filters: {
      conditions: [
        {
          key: 'Thinkific ID|rich_text',
          condition: 'is_not_empty',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [120, -620],
    id: '716828f3-b7c6-473c-875d-50c6a7fe8341',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
getProducts.alwaysOutputData = true;
getProducts.executeOnce = true;

// --- Tag incoming records ---
const tagIncoming = createNode(
  'Tag incoming records',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '18beaffe-10a3-4563-961c-423d31a7855e',
          name: 'lms',
          value: '={{ $json }}',
          type: 'object',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [340, -820],
    id: '36ec6f33-ea09-4691-ac4d-ea34ffe85800',
  }
);
tagIncoming.alwaysOutputData = true;

// --- Tag Notion Records ---
const tagNotion = createNode(
  'Tag Notion Records',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '881521e6-8a22-449e-a6d1-1088c404728b',
          name: 'notion',
          value: '={{ $json }}',
          type: 'object',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [340, -620],
    id: 'c8dc1458-91fb-491a-a0c9-6cbf0e64647c',
  }
);
tagNotion.alwaysOutputData = true;

// --- Merge Records ---
const merge = createNode(
  'Merge Records',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    advanced: true,
    mergeByFields: {
      values: [
        {
          field1: 'lms.lms_id',
          field2: 'notion.property_thinkific_id',
        },
      ],
    },
    joinMode: 'keepEverything',
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [560, -720],
    id: 'd6925a37-4264-4574-ad4f-74f8d10fc38f',
  }
);

// --- Remove Empty Records (Filter) ---
const removeEmpty = createNode(
  'Remove Empty Records',
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
          id: '149f8616-0382-42a8-964b-d6fc09ea79c9',
          leftValue: '={{ $json.lms }}',
          rightValue: 0,
          operator: {
            type: 'object',
            operation: 'exists',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [780, -720],
    id: 'edfa18b2-11b8-4998-88f6-12a231324cc2',
  }
);

// --- De-Dup Vs Notion (Code) ---
const deDup = createNode(
  'De-Dup Vs Notion',
  'n8n-nodes-base.code',
  {
    jsCode: "\n$input.all().forEach(item => {\n  item.json.operation =\n    item.json.hasOwnProperty('notion')?\n    'update' : 'create';\n})\n\n\nreturn $input.all();",
  },
  {
    typeVersion: 2,
    position: [1000, -720],
    id: 'e39db2f7-6a6e-493f-9bc0-13f53c7ed9d1',
  }
);

// --- Switch Notion Operation ---
const switchOp = createNode(
  'Switch Notion Operation',
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
                id: 'c55843e7-2992-40e7-a802-36f1d5c33f56',
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
                id: '475e8d22-cc7b-448d-aaa8-8bf21cd10640',
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
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.2,
    position: [1220, -720],
    id: '4831cf11-9cbc-41dc-b239-07512ffc9811',
  }
);

// --- Notion (Create product) ---
const notionCreate = createNode(
  'Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    databaseId: {
      __rl: true,
      value: '1d48ebaf-15ee-80c4-a8e7-d99c0596d520',
      mode: 'list',
      cachedResultName: 'Web DB: Products',
      cachedResultUrl: 'https://www.notion.so/1d48ebaf15ee80c4a8e7d99c0596d520',
    },
    title: '={{ $json.lms.title }}',
    propertiesUi: {
      propertyValues: [
        {
          key: 'Description (250 chars)|rich_text',
          textContent: '={{ $json.lms.description }}',
        },
        {
          key: 'Download Image|files',
          fileUrls: {
            fileUrl: [
              {
                name: 'thumbnail',
                url: '={{ $json.lms.thumbnail }}',
              },
            ],
          },
        },
        {
          key: 'Release Date|date',
          date: "={{ $json.lms.release_date || '' }}",
        },
        {
          key: 'Store Product Link|url',
          ignoreIfEmpty: true,
          urlValue: '={{ $json.lms.product_page_link }}',
        },
        {
          key: 'Thinkific ID|rich_text',
          textContent: '={{ $json.lms.lms_id }}',
        },
        {
          key: 'Thinkific Type|select',
          selectValue: '={{ $json.lms.product_type }}',
        },
        {
          key: 'Visible|checkbox',
          checkboxValue: '={{ $json.lms.visible }}',
        },
        {
          key: 'Thinkific Category|multi_select',
          multiSelectValue: '={{ $json.lms.product_categories }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1440, -820],
    id: 'ec8546bc-e3de-41a5-a0c3-a1de5b698e72',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);

// --- Filter Unchanged ---
const filterUnchanged = createNode(
  'Filter Unchanged',
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
          id: '35d9f737-f0c7-42fc-a07f-e21d3d973526',
          leftValue: '={{ $json.lms.title }}',
          rightValue: '={{ $json.notion.name }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: '3805deee-fcaa-495e-bb05-16e4caeb56c2',
          leftValue: '={{ $json.lms.thumbnail }}',
          rightValue: '={{ $json.notion.property_download_image[0] }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: 'd9cc6860-ede4-4347-82a3-f5ac3971de22',
          leftValue: '={{ $json.lms.product_type }}',
          rightValue: '={{ $json.notion.property_thinkific_type }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: 'faabd8d6-c0f0-40b1-a05b-1016750bde10',
          leftValue: '={{ $json.lms.description }}',
          rightValue: '={{ $json.notion.property_description_250_chars }}',
          operator: {
            type: 'string',
            operation: 'notEquals',
          },
        },
        {
          id: 'fc8e03cd-9a5e-467a-bcc9-6927235fc051',
          leftValue: '={{ $json.lms.price }}',
          rightValue: '={{ $json.notion.property_price }}',
          operator: {
            type: 'number',
            operation: 'notEquals',
          },
        },
        {
          id: 'd8723722-9ae2-4c3b-a446-e0d567e85ec9',
          leftValue: '={{ $json.lms.product_categories.toString() }}',
          rightValue: '={{ $json.notion.property_thinkific_category.toString() }}',
          operator: {
            type: 'string',
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
    position: [1440, -620],
    id: '16f4d7db-0461-4020-8f0d-dd1c2638f4f1',
  }
);

// --- Update Product (Notion) ---
const updateProduct = createNode(
  'Update Product',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: '={{ $json.notion.id }}',
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        {
          key: 'Description (250 chars)|rich_text',
          textContent: '={{ $json.lms.description }}',
        },
        {
          key: 'Download Image|files',
          fileUrls: {
            fileUrl: [
              {
                name: '=thumbnail_{{ $json.lms.lms_id }}',
                url: '={{ $json.lms.thumbnail }}',
              },
            ],
          },
        },
        {
          key: 'Price|number',
          numberValue: '={{ $json.lms.price }}',
        },
        {
          key: 'Thinkific ID|rich_text',
          textContent: '={{ $json.lms.lms_id }}',
        },
        {
          key: 'Thinkific Type|select',
          selectValue: '={{ $json.lms.product_type }}',
        },
        {
          key: 'Visible|checkbox',
          checkboxValue: '={{ $json.lms.visible }}',
        },
        {
          key: 'Thinkific Category|multi_select',
          multiSelectValue: '={{ $json.lms.product_categories }}',
        },
        {
          key: 'Title|title',
          title: '={{ $json.lms.title }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1660, -620],
    id: '4e61dcf2-7cce-40b2-bbad-9c8b6451ce45',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);

// --- Connections ---
const connections = [
  // Trigger fans out to Get Products and Fix Product Type
  connect(trigger, getProducts),
  connect(trigger, fixProductType),
  // Get Products → Tag Notion Records → Merge input 1
  connect(getProducts, tagNotion),
  connect(tagNotion, merge, 0, 1),
  // Fix Product Type → Tag incoming → Merge input 0
  connect(fixProductType, tagIncoming),
  connect(tagIncoming, merge, 0, 0),
  // Merge → Remove Empty → De-Dup → Switch
  connect(merge, removeEmpty),
  connect(removeEmpty, deDup),
  connect(deDup, switchOp),
  // Switch output 0 (Create) → Notion Create
  connect(switchOp, notionCreate, 0),
  // Switch output 1 (Update) → Filter Unchanged → Update Product
  connect(switchOp, filterUnchanged, 1),
  connect(filterUnchanged, updateProduct),
];

export default createWorkflow('Notion: Update Products', {
  nodes: [
    getProducts, tagNotion, deDup, switchOp, trigger,
    notionCreate, tagIncoming, removeEmpty, merge,
    filterUnchanged, updateProduct, fixProductType,
  ],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
