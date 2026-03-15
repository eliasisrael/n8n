import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Execute Workflow Trigger ---
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    workflowInputs: {
      values: [
        { name: 'email' },
        { name: 'firstName' },
        { name: 'lastName' },
        { name: 'company' },
        { name: 'country' },
        { name: 'phone' },
      ],
    },
  },
  {
    typeVersion: 1.1,
    position: [288, 32],
    id: '42b8ce77-3064-4f61-a54c-5a67b385a2bf',
  }
);

// --- Loop Over Items ---
const loop = createNode(
  'Loop Over Items',
  'n8n-nodes-base.splitInBatches',
  {
    options: {},
  },
  {
    typeVersion: 3,
    position: [512, 32],
    id: '0c79962d-78f5-4f74-b28e-0fec9bba7be3',
  }
);

// --- Get many database pages (Notion lookup) ---
const getPages = createNode(
  'Get many database pages',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd',
      mode: 'list',
      cachedResultName: 'Web DB: Master Contacts',
      cachedResultUrl: 'https://www.notion.so/1688ebaf15ee806bbd12dd7c8caf2bdd',
    },
    filterType: 'manual',
    matchType: 'allFilters',
    filters: {
      conditions: [
        {
          key: 'Email|email',
          condition: 'equals',
          emailValue: '={{ $json.email }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [736, 32],
    id: 'f15926b4-17ee-4ba6-8b2a-f10c4ff4fdfe',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
getPages.alwaysOutputData = true;

// --- If (contact exists?) ---
const ifNode = createNode(
  'If',
  'n8n-nodes-base.if',
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
          id: '4ba613fe-80cc-4ea6-9f3a-343be684b83b',
          leftValue: '={{ $json.id }}',
          rightValue: '',
          operator: {
            type: 'string',
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
    position: [960, 32],
    id: 'a9b236c1-d034-44ac-ade1-1cb9b5152f77',
  }
);

// --- Update a database page (add "Launch team" tag) ---
const updatePage = createNode(
  'Update a database page',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: '={{ $json.id }}',
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        {
          key: 'Tags|multi_select',
          multiSelectValue: '={{ [...new Set([...$json.property_tags, "Launch team"])] }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1184, -64],
    id: 'f2da8026-75af-40c8-9628-b789271a3ff4',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);

// --- Create a database page ---
const createPage = createNode(
  'Create a database page',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    databaseId: {
      __rl: true,
      value: '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd',
      mode: 'list',
      cachedResultName: 'Web DB: Master Contacts',
      cachedResultUrl: 'https://www.notion.so/1688ebaf15ee806bbd12dd7c8caf2bdd',
    },
    title: "={{ $('Loop Over Items').item.json.email }}",
    propertiesUi: {
      propertyValues: [
        {
          key: 'Email|email',
          emailValue: "={{ $('Loop Over Items').item.json.email }}",
        },
        {
          key: 'Tags|multi_select',
          multiSelectValue: ['Launch team'],
        },
        {
          key: 'Email Marketing|select',
          selectValue: 'Unsubscribed',
        },
        {
          key: 'First name|rich_text',
          textContent: "={{ $('Loop Over Items').item.json.firstName }}",
        },
        {
          key: 'Last name|rich_text',
          textContent: "={{ $('Loop Over Items').item.json.lastName }}",
        },
        {
          key: 'Company Name|rich_text',
          textContent: "={{ $('Loop Over Items').item.json.company }}",
        },
        {
          key: 'Country|rich_text',
          textContent: "={{ $('Loop Over Items').item.json.country }}",
        },
        {
          key: 'Phone|phone_number',
          phoneValue: "={{ $('Loop Over Items').item.json.phone }}",
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1184, 128],
    id: 'd097d0f6-0b05-42a9-b317-2ad7dbdadab2',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);

// --- Wait 1s ---
const wait = createNode(
  'Wait 1s',
  'n8n-nodes-base.wait',
  {
    amount: 1,
  },
  {
    typeVersion: 1.1,
    position: [1408, 112],
    id: '39d8f60a-bead-4dfb-ad24-d2e8e73d65b8',
  }
);
wait.webhookId = '5d40d370-d0cd-413e-98f5-48ec9b2cd0ab';

// --- Done (No Operation) ---
const done = createNode(
  'Done',
  'n8n-nodes-base.noOp',
  {},
  {
    typeVersion: 1,
    position: [736, -160],
    id: '79f0f967-c07f-4759-a528-d9bca6edebe9',
  }
);

// --- Connections ---
const connections = [
  connect(trigger, loop),
  // Loop output 0 (done) → Done
  connect(loop, done, 0),
  // Loop output 1 (each item) → Get many database pages
  connect(loop, getPages, 1),
  connect(getPages, ifNode),
  // If true → Update
  connect(ifNode, updatePage, 0),
  // If false → Create
  connect(ifNode, createPage, 1),
  // Both Update and Create → Wait 1s
  connect(updatePage, wait),
  connect(createPage, wait),
  // Wait → Loop (back to next item)
  connect(wait, loop),
];

export default createWorkflow('MDI Subscriber Bulk Upload', {
  nodes: [getPages, ifNode, updatePage, createPage, trigger, loop, wait, done],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
