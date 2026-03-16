import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const stickyNote = createNode(
  'Sticky Note',
  'n8n-nodes-base.stickyNote',
  {
    content: '### Incoming is a JSON record that describes a product in the LMS system\n\nFormat and store it in Notion in the Web DB: Products database\n',
    width: 300,
    color: 4,
  },
  {
    typeVersion: 1,
    position: [-440, -240],
    id: '454b3c09-a9fc-45bb-a5a7-5ce685a5ee0b',
  },
);

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: '{\n"id": "string",\n "title": "string",\n"benefit1": "string",\n  "benefit2": "string",\n  "benefit3": "string",\n  "download_image": "string",\n  "price":100.0,\n  "abstract":"",\n  "store_link": "URL",\n  "release_date":"iso date",\n  "description":"string",\n  "thinkific_cateories": ["Courses", "Downloads"],\n  "thinkific_type": "string",\n  "tag":"string",\n  "visible":true\n}',
  },
  {
    typeVersion: 1.1,
    position: [0, -80],
    id: 'b8b75de0-a09d-4fee-95f5-d8599da2a867',
  },
);

const notionLookup = createNode(
  'Notion1',
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
    filterType: 'manual',
    filters: {
      conditions: [
        {
          key: 'Thinkific ID|rich_text',
          condition: 'equals',
          richTextValue: '={{ $json.id }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [220, -180],
    id: 'c6a50dfe-bf79-4db9-abdc-1b8ed4873850',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  },
);
notionLookup.alwaysOutputData = true;

const wrapNotionRecord = createNode(
  'Wrap Notion Record',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'fb03ce52-7299-4b77-8f41-19ba2ef254c9',
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
    position: [440, -180],
    id: '8f2197d9-0985-4191-928a-47bef5c9fcde',
  },
);

const wrapIncoming = createNode(
  'Wrap Incoming',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'ca0f7d26-232a-4eb6-8cf7-9e09bc544857',
          name: 'thinkific',
          value: '={{ $json }}',
          type: 'object',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [440, 20],
    id: '387a3b5d-825b-47f8-bbc5-0bc25b0c8293',
  },
);

const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    advanced: true,
    mergeByFields: {
      values: [
        {
          field1: "=notion['Thinkific ID']",
          field2: 'thinkific.id',
        },
      ],
    },
    joinMode: 'keepEverything',
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [660, -80],
    id: 'fc24fcbb-192c-4079-a5a0-f9802ce34d7a',
  },
);

const code = createNode(
  'Code',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: "let operation = 'noop';\nconst item = $input.item.json;\n\nif (item.hasOwnProperty('notion')) {\n  if (item.hasOwnProperty('thinkific')) {\n    operation = 'update'\n  }\n}\nelse {\n  operation = 'create';\n}\n\n$input.item.json.operation = operation;\n\nreturn $input.item;",
  },
  {
    typeVersion: 2,
    position: [880, -80],
    id: 'e096ca49-997f-4e8a-ba78-a123e0a8b67b',
  },
);

const selectOperation = createNode(
  'Select Operation',
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
                id: '593fc955-726f-4889-bfa7-a2aad84fae0c',
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Create Product',
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
                id: 'f4e2f1a3-1176-4239-9e4d-69d8fe70357a',
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
          outputKey: 'Update Product',
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
                id: 'f463d9b7-01b3-48da-af0d-66bbed9592c7',
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
    options: {},
  },
  {
    typeVersion: 3.2,
    position: [1100, -80],
    id: 'f445f2d2-ba4a-4e38-aa0c-5cfe268dfcc5',
  },
);

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
    title: '={{ $json.thinkific.title }}',
    propertiesUi: {
      propertyValues: [
        {
          key: 'Description (250 chars)|rich_text',
          textContent: '={{ $json.thinkific.description }}',
        },
        {
          key: 'Price|number',
          numberValue: '={{ $json.thinkific.price }}',
        },
        {
          key: 'Product Abstract|rich_text',
          textContent: '={{ $json.thinkific.abstract }}',
        },
        {
          key: 'Release Date|date',
          date: '={{ $json.thinkific.release_date }}',
        },
        {
          key: 'Store Product Link|url',
          urlValue: '={{ $json.thinkific.store_link }}',
        },
        {
          key: 'Tag|select',
          selectValue: '={{ $json.thinkific.tag }}',
        },
        {
          key: 'Thinkific Category|multi_select',
          multiSelectValue: '={{ $json.thinkific_categories }}',
        },
        {
          key: 'Thinkific Type|select',
          selectValue: '={{ $json.thinkific.thinkific_type }}',
        },
        {
          key: 'Visible|checkbox',
          checkboxValue: '={{ $json.thinkific.visible }}',
        },
        {
          key: "You'll Learn (Benefit 1)|rich_text",
          textContent: '={{ $json.thinkific.benefit1 }}',
        },
        {
          key: "You'll Learn (Benefit 2)|rich_text",
          textContent: '={{ $json.thinkific.benefit2 }}',
        },
        {
          key: "You'll Learn (Benefit 3)|rich_text",
          textContent: '={{ $json.thinkific.benefit3 }}',
        },
        {
          key: 'Download Image|files',
          fileUrls: {
            fileUrl: [
              {
                name: '=Thumbnail',
                url: '={{ $json.thinkific.download_image }}',
              },
            ],
          },
        },
        {
          key: 'Thinkific ID|rich_text',
          textContent: '={{ $json.thinkific.id }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1320, -280],
    id: 'd25c405a-4f9d-444c-8ac9-3773cedd2e29',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  },
);

const notionUpdate = createNode(
  'Notion2',
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
        {},
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1320, -80],
    id: '503a493a-b144-4208-9443-ced8c71e8f79',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  },
);

const noOp = createNode(
  'No Operation, do nothing',
  'n8n-nodes-base.noOp',
  {},
  {
    typeVersion: 1,
    position: [1320, 120],
    id: '046b7657-06e2-439a-980a-db58b16ca43e',
  },
);

export default createWorkflow('Store LMS Product', {
  nodes: [stickyNote, trigger, notionCreate, notionLookup, wrapNotionRecord, wrapIncoming, merge, code, selectOperation, noOp, notionUpdate],
  connections: [
    connect(trigger, notionLookup),
    connect(trigger, wrapIncoming),
    connect(notionLookup, wrapNotionRecord),
    connect(wrapNotionRecord, merge, 0, 0),
    connect(wrapIncoming, merge, 0, 1),
    connect(merge, code),
    connect(code, selectOperation),
    connect(selectOperation, notionCreate, 0),
    connect(selectOperation, notionUpdate, 1),
    connect(selectOperation, noOp, 2),
  ],
  settings: { executionOrder: 'v1' },
});
