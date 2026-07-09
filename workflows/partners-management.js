import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// Route the partner Logo through the shared Webflow Image Ingest sub-workflow
// (Plan → Emit → Ingest → Apply) so oversized logos are resized and become
// permanent Webflow-hosted assets. Both the create and update paths set the
// logo (the update path previously set only `name`, so partner logo edits
// never propagated — now they do).
const INGEST_WORKFLOW_ID = 'ukgsdamtBYr76U2i';

const PLAN_IMAGES_CODE = `
const r = $json;
const plan = [];
const logo = Array.isArray(r.Logo) ? r.Logo[0] : r.Logo;
if (logo) plan.push({ field: 'Logo', url: logo });
return { json: { ...r, _imgPlan: plan } };
`.trim();

const EMIT_IMAGES_CODE = `
const rec = $input.first().json;
const plan = rec._imgPlan || [];
return plan.map(p => ({ json: { imageUrl: p.url } }));
`.trim();

function applyHostedCode(planNode) {
  return `
const rec = $('${planNode}').first().json;
const plan = rec._imgPlan || [];
const hosted = $input.all().map(it => it.json.hostedUrl);
const out = { ...rec };
for (let i = 0; i < plan.length; i++) { if (hosted[i]) out[plan[i].field] = [hosted[i]]; }
delete out._imgPlan;
return { json: out };
`.trim();
}

function planNode(name, position) {
  return createNode(name, 'n8n-nodes-base.code', { mode: 'runOnceForEachItem', jsCode: PLAN_IMAGES_CODE }, { typeVersion: 2, position });
}
function emitNode(name, position) {
  return createNode(name, 'n8n-nodes-base.code', { mode: 'runOnceForAllItems', jsCode: EMIT_IMAGES_CODE }, { typeVersion: 2, position });
}
function ingestNode(name, position) {
  const n = createNode(name, 'n8n-nodes-base.executeWorkflow', { workflowId: { __rl: true, mode: 'id', value: INGEST_WORKFLOW_ID }, options: {} }, { typeVersion: 1.2, position });
  n.retryOnFail = true;
  return n;
}
function applyNode(name, planNodeName, position) {
  return createNode(name, 'n8n-nodes-base.code', { mode: 'runOnceForAllItems', jsCode: applyHostedCode(planNodeName) }, { typeVersion: 2, position });
}

const planUpdate = planNode('Plan Images (Update)', [-720, 20]);
const emitUpdate = emitNode('Emit Image Items (Update)', [-700, 20]);
const ingestUpdate = ingestNode('Ingest Images (Update)', [-680, 20]);
const applyUpdate = applyNode('Apply Hosted (Update)', 'Plan Images (Update)', [-640, 20]);

const planCreate = planNode('Plan Images (Create)', [-800, 620]);
const emitCreate = emitNode('Emit Image Items (Create)', [-720, 620]);
const ingestCreate = ingestNode('Ingest Images (Create)', [-660, 620]);
const applyCreate = applyNode('Apply Hosted (Create)', 'Plan Images (Create)', [-620, 620]);

// --- Nodes ---

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { typeVersion: 1.1, position: [-1240, 220], id: '06f7cbec-aa8b-4745-b39d-26b414a34ba8' },
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
          operator: { type: 'string', operation: 'exists', singleValue: true },
        },
        {
          id: 'b280b992-96aa-412f-848a-de8b6b1ac44b',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-1020, 220], id: '32f7366a-9162-4c60-8e61-bd8937ba856c' },
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
          id: '8225156b-e0d9-41f5-9e75-9bb138b489d9',
          leftValue: '={{ $json.Logo[0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '1a8b75ec-87c5-44cf-95f3-56ccf050fc95',
          leftValue: '={{ $json["List on site?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: 'c28e60d4-30f7-416e-8f22-1eaf64c4670b',
          leftValue: '={{ $json.Name }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-800, 120], id: '5d31577a-7790-42b9-a249-dfeff180f082' },
);

const updateWebflow = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a26f5e9084457b133b0f',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] }}' },
      ],
    },
  },
  {
    typeVersion: 2,
    position: [-580, 20],
    id: '6f3c4fb6-c0c9-4164-b6ae-a8285373d039',
    credentials: { webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' } },
  },
);

const deletePartner = createNode(
  'Delete Partner Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'deleteItem',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a26f5e9084457b133b0f',
    itemId: '={{ $json.WebflowId }}',
  },
  {
    typeVersion: 2,
    position: [-580, 220],
    id: '9c630bfb-d8dd-4ba0-be43-5e9f1f2944b6',
    credentials: { webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' } },
  },
);

const unlinkWebflowId = createNode(
  'Unlink webflow id in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      value: "={{ $('Updated Partner in Notion').item.json.id }}",
      mode: 'id',
    },
    propertiesUi: {
      propertyValues: [
        { key: 'WebflowId|rich_text' },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-360, 220],
    id: '009845db-6ea1-428a-9403-aed65c504bd4',
    credentials: { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } },
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
          id: 'fd62a2cf-7c40-496b-8f4d-78ce3810871a',
          leftValue: '={{ $json.Logo[0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '4f4b4beb-b512-4531-9485-61e1e3190046',
          leftValue: '={{ $json.id }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '77465a24-ff7d-4b83-a32b-66b6c7b15aff',
          leftValue: '={{ $json["List on site?"] }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-800, 420], id: '666f83a8-7b64-4d06-a6eb-4b301cb3d969' },
);

const webflowCreate = createNode(
  'Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a26f5e9084457b133b0f',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
        { fieldId: 'site', fieldValue: '={{ $json.Site }}' },
        { fieldId: 'notionid', fieldValue: '={{ $json.id }}' },
      ],
    },
  },
  {
    typeVersion: 2,
    position: [-580, 420],
    id: '134c3a85-ce56-41cc-b35d-5ee62cb3849f',
    credentials: { webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' } },
  },
);
webflowCreate.alwaysOutputData = true;

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
        { key: 'WebflowId|rich_text', textContent: '={{ $json.id }}' },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-360, 420],
    id: '58d038b8-3dc0-4730-bd49-94711bb4e4ec',
    credentials: { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } },
  },
);

// --- Workflow ---

export default createWorkflow('Partners Management', {
  nodes: [
    trigger,
    alreadyStored,
    ifPublishable,
    updateWebflow,
    deletePartner,
    unlinkWebflowId,
    filterPublishable,
    webflowCreate,
    storeWebflowId,
    planUpdate,
    emitUpdate,
    ingestUpdate,
    applyUpdate,
    planCreate,
    emitCreate,
    ingestCreate,
    applyCreate,
  ],
  connections: [
    connect(trigger, alreadyStored),
    connect(alreadyStored, ifPublishable, 0),        // true: has WebflowId
    connect(alreadyStored, filterPublishable, 1),     // false: no WebflowId
    // Publishable → resolve logo image → update
    connect(ifPublishable, planUpdate, 0),
    connect(planUpdate, emitUpdate),
    connect(emitUpdate, ingestUpdate),
    connect(ingestUpdate, applyUpdate),
    connect(applyUpdate, updateWebflow),
    connect(ifPublishable, deletePartner, 1),         // false: not publishable → delete
    connect(deletePartner, unlinkWebflowId),
    // Create path: resolve logo image → create → store id
    connect(filterPublishable, planCreate),
    connect(planCreate, emitCreate),
    connect(emitCreate, ingestCreate),
    connect(ingestCreate, applyCreate),
    connect(applyCreate, webflowCreate),
    connect(webflowCreate, storeWebflowId),
  ],
  settings: { executionOrder: 'v1' },
  tags: [
    { id: 'mSZQb74EXyrIkTsb', name: 'website' },
    { id: 'IzLCnCZq9323eiAZ', name: 'Production' },
  ],
});
