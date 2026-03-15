import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Sticky Note ---
const stickyNote = createNode(
  'Sticky Note1',
  'n8n-nodes-base.stickyNote',
  {
    content: '## Handle Additionas, Changes, and Mailchimp Unsubscriptions',
    height: 260,
    width: 1200,
  },
  {
    typeVersion: 1,
    position: [-264, -148],
    id: '2181733a-ef13-4b1f-826f-d2990a69eda9',
  }
);

// --- User Unsubscribe (Mailchimp Trigger) ---
const trigger = createNode(
  'User Unsubscribe',
  'n8n-nodes-base.mailchimpTrigger',
  {
    authentication: 'oAuth2',
    list: '77d135987f',
    events: ['unsubscribe'],
    sources: ['user', 'admin', 'api'],
  },
  {
    typeVersion: 1,
    position: [-160, -48],
    id: '89bda88a-b5eb-4741-8980-c3db4b1f74b8',
    credentials: {
      mailchimpOAuth2Api: {
        id: 'DtyHZOOulvefkbC3',
        name: 'Mailchimp account',
      },
    },
  }
);
trigger.webhookId = '99e2afc1-1411-4d6a-b07b-35d47109b995';

// --- Edit Fields (restructure Mailchimp webhook data) ---
const editFields = createNode(
  'Edit Fields',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        { id: '2d2813d0-f574-4b2b-93d2-08a48e84009e', name: 'type', value: '={{ $json.type }}', type: 'string' },
        { id: 'ef2ec13d-fdf4-41aa-b200-f59a1beacbf5', name: 'fired_at', value: '={{ $json.fired_at }}', type: 'string' },
        { id: '2ab55d4a-ac44-4937-b9f7-b6aaf80f2fd0', name: 'data.list_id', value: '={{ $json["data[list_id]"] }}', type: 'string' },
        { id: 'b2c9184a-1561-4439-9259-050421fc3700', name: 'data.action', value: '={{ $json["data[action]"] }}', type: 'string' },
        { id: 'd04217e2-e3d9-4740-881d-077d12120b52', name: 'data.reason', value: '={{ $json["data[reason]"] }}', type: 'string' },
        { id: '31d7193c-6f3e-4229-a825-510ac7087e1d', name: 'data.email', value: '={{ $json["data[email]"] }}', type: 'string' },
        { id: '3d980228-9e6a-4be2-92ed-ae2d0a2a2175', name: 'data.ip_opt', value: '={{ $json["data[ip_opt]"] }}', type: 'string' },
        { id: '6b21c78c-31e7-41d3-828c-0b2a42ff8be9', name: 'data.web_id', value: '={{ $json["data[web_id]"] }}', type: 'string' },
        { id: 'c40ff222-9be7-4798-80e5-669fda46dd5e', name: 'data.id', value: '={{ $json["data[id]"] }}', type: 'string' },
        { id: '0b5e82e6-042c-446d-8c3c-b46aafb67063', name: 'data.merges.email', value: '={{ $json["data[merges][EMAIL]"] }}', type: 'string' },
        { id: '5cfac0aa-3630-4776-9cd4-e717fc89147a', name: 'data.merges.FNAME', value: '={{ $json["data[merges][FNAME]"] }}', type: 'string' },
        { id: '93bea4e7-62ff-438e-9f7d-5a6abc500743', name: 'data.merges.LNAME', value: '={{ $json["data[merges][LNAME]"] }}', type: 'string' },
        { id: '2837357d-8a05-4293-bb61-fba6587a2864', name: 'data.merges.ADDRESS', value: '={{ $json["data[merges][ADDRESS]"] }}', type: 'string' },
        { id: 'e4540c3a-1c7e-4e03-a573-5b69cab24a01', name: 'data.merges.PHONE', value: '={{ $json["data[merges][PHONE]"] }}', type: 'string' },
        { id: 'f0f3e0a7-68cd-42d6-aca4-50955c738e0f', name: 'data.merges.BIRTHDAY', value: '={{ $json["data[merges][BIRTHDAY]"] }}', type: 'string' },
        { id: '037d299d-4423-4a49-afa2-de7da0cddf09', name: 'data.merges.COMPANY', value: '={{ $json["data[merges][COMPANY]"] }}', type: 'string' },
        { id: 'e45af1b3-944c-457e-91a0-9a932da93a55', name: 'data.merges.TITLE', value: '={{ $json["data[merges][TITLE]"] }}', type: 'string' },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [64, -48],
    id: '936669cf-3885-4324-b54d-f4468d62f0f6',
  }
);

// --- Filter (only unsubscribe events) ---
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
          id: 'bb2fc06a-c8c7-40bd-a887-efaf8bfe0edf',
          leftValue: '={{ $json.type }}',
          rightValue: 'unsubscribe',
          operator: {
            type: 'string',
            operation: 'equals',
            name: 'filter.operator.equals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [288, -48],
    id: 'd3a6e6e8-7b45-4bad-bfda-9bda64c40d51',
  }
);

// --- Notion1 (lookup contact by email) ---
const notion1 = createNode(
  'Notion1',
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
    returnAll: true,
    filterType: 'manual',
    matchType: 'allFilters',
    filters: {
      conditions: [
        {
          key: 'Email|email',
          condition: 'equals',
          emailValue: '={{ $json.data.email }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [512, -48],
    id: 'd4a47319-5a52-4882-8b9b-1a9aeed2c06b',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
notion1.retryOnFail = true;

// --- Notion2 (update Email Marketing to Unsubscribed) ---
const notion2 = createNode(
  'Notion2',
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
          key: 'Email Marketing|select',
          selectValue: 'Unsubscribed',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [736, -48],
    id: 'caed584d-676a-4f6c-b0c1-11a1fe75c814',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
notion2.retryOnFail = true;

// --- Connections ---
const connections = [
  connect(trigger, editFields),
  connect(editFields, filter),
  connect(filter, notion1),
  connect(notion1, notion2),
];

export default createWorkflow('Handle Unsubs', {
  nodes: [trigger, stickyNote, editFields, notion1, notion2, filter],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
