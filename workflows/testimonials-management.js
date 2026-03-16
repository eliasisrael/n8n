import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'passthrough',
  },
  {
    typeVersion: 1.1,
    position: [-1060, 380],
    id: '16c06ebd-c5a4-4f0f-ac58-a60b94619953',
  },
);

const alreadyStored = createNode(
  'Already Stored?',
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
          id: '4bd52b16-e8bc-4cac-933f-481281f3c979',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'exists',
            singleValue: true,
          },
        },
        {
          id: 'b280b992-96aa-412f-848a-de8b6b1ac44b',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
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
    position: [-840, 380],
    id: 'df150bc4-4d8b-49f7-b61b-fe50246f4284',
  },
);

const ifPublishable = createNode(
  'If Publishable',
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
          id: '8b48d186-2762-4bc1-b155-1089141c0834',
          leftValue: '={{ $json["Approved?"] }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        },
        {
          id: '234a36d3-67c4-41fe-a77f-ffacadf02a7c',
          leftValue: '={{ $json.Headshot[0] }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
        {
          id: '2710f590-d96e-427e-8926-d278b9c8f67d',
          leftValue: '={{ $json.Testimonial }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
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
    position: [-620, 280],
    id: 'a074f079-2c5c-48b4-9732-e3ac51b6e5df',
  },
);

const filterPublishable = createNode(
  'Filter: Publishable',
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
          id: '643e2a76-d707-4259-9f15-b7dd6e5c7e8e',
          leftValue: '={{ $json["Approved?"] }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        },
        {
          id: 'bd865c1d-a997-47eb-9106-157f16ab9c11',
          leftValue: '={{ $json.Testimonial }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
        {
          id: '271b1458-a25a-48fa-8a2e-e6f76a352d20',
          leftValue: '={{ $json.Headshot[0] }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
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
    position: [-620, 580],
    id: 'e351ada2-608d-43a7-97d1-9645ba01cc96',
  },
);

const updateWebflow = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099d7ed2eba962dd2ae48d',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'title', fieldValue: '={{ $json.Affiliation }}' },
        { fieldId: 'logo', fieldValue: '={{ $json.Logo }}' },
        { fieldId: 'testimonial', fieldValue: '={{ $json.Testimonial }}' },
        { fieldId: 'headshot', fieldValue: '={{ $json.Headshot }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  {
    typeVersion: 2,
    position: [-400, 180],
    id: 'a78b20bc-b3ee-4c11-bf0e-b874cb70cbb1',
    credentials: {
      webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
    },
  },
);

const deleteFromWebflow = createNode(
  'Delete from Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'deleteItem',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099d7ed2eba962dd2ae48d',
    itemId: "={{ $('Updated Testimonial in Notion').item.json.WebflowId }}",
  },
  {
    typeVersion: 2,
    position: [-400, 380],
    id: '465f9c2d-a411-424a-a112-9d4c9a3aa2a7',
    credentials: {
      webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
    },
  },
);

const webflowCreate = createNode(
  'Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099d7ed2eba962dd2ae48d',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'title', fieldValue: '={{ $json.Affiliation }}' },
        { fieldId: 'logo', fieldValue: '={{ $json.Logo }}' },
        { fieldId: 'testimonial', fieldValue: '={{ $json.Testimonial }}' },
        { fieldId: 'headshot', fieldValue: '={{ $json.Headshot[0] }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  {
    typeVersion: 2,
    position: [-400, 580],
    id: 'bf2a1824-d280-49d1-b6f1-359034517fa9',
    credentials: {
      webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
    },
  },
);

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: "={{ $('Filter: Publishable').item.json.id }}",
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        {
          key: 'WebflowId|rich_text',
          textContent: '={{ $json.id }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-180, 580],
    id: '32bd75a7-0857-40c3-a120-4e1d485aeb9f',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  },
);

const unlinkWebflowId = createNode(
  'Notion: Unlink Webflow ID',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: "={{ $('Updated Testimonial in Notion').item.json.id }}",
      mode: 'id',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-180, 380],
    id: '7b720a45-3859-4a0d-85eb-8c6259559ffb',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  },
);

export default createWorkflow('Testimonials Management', {
  nodes: [
    alreadyStored,
    webflowCreate,
    storeWebflowId,
    updateWebflow,
    deleteFromWebflow,
    ifPublishable,
    filterPublishable,
    unlinkWebflowId,
    trigger,
  ],
  connections: [
    connect(trigger, alreadyStored),
    connect(alreadyStored, ifPublishable, 0),
    connect(alreadyStored, filterPublishable, 1),
    connect(ifPublishable, updateWebflow, 0),
    connect(ifPublishable, deleteFromWebflow, 1),
    connect(filterPublishable, webflowCreate),
    connect(webflowCreate, storeWebflowId),
    connect(deleteFromWebflow, unlinkWebflowId),
  ],
  settings: {
    executionOrder: 'v1',
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});
