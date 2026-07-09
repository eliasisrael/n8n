import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// Route testimonial images (Headshot required, Logo optional) through the shared
// Webflow Image Ingest sub-workflow so oversized images are resized and all
// images become permanent Webflow-hosted assets instead of ephemeral Notion
// URLs. Per path: Plan Images → Emit image items → Ingest (multi-image) →
// Apply hosted URLs back onto the record (recovered via node reference).
const INGEST_WORKFLOW_ID = 'ukgsdamtBYr76U2i';
const WEBFLOW_CREDENTIAL = { webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' } };
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };

// Ordered plan of the record's present image fields (headshot first, logo if any).
const PLAN_IMAGES_CODE = `
const r = $json;
const plan = [];
const headshot = Array.isArray(r.Headshot) ? r.Headshot[0] : r.Headshot;
const logo = Array.isArray(r.Logo) ? r.Logo[0] : r.Logo;
if (headshot) plan.push({ field: 'Headshot', url: headshot });
if (logo) plan.push({ field: 'Logo', url: logo });
return { json: { ...r, _imgPlan: plan } };
`.trim();

const EMIT_IMAGES_CODE = `
const rec = $input.first().json;
const plan = rec._imgPlan || [];
return plan.map(p => ({ json: { imageUrl: p.url } }));
`.trim();

// Recover the record via a node reference to the Plan node (order-preserving:
// hosted[i] corresponds to _imgPlan[i]).
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
  return createNode(name, 'n8n-nodes-base.code',
    { mode: 'runOnceForEachItem', jsCode: PLAN_IMAGES_CODE },
    { typeVersion: 2, position });
}
function emitNode(name, position) {
  return createNode(name, 'n8n-nodes-base.code',
    { mode: 'runOnceForAllItems', jsCode: EMIT_IMAGES_CODE },
    { typeVersion: 2, position });
}
function ingestNode(name, position) {
  const n = createNode(name, 'n8n-nodes-base.executeWorkflow',
    { workflowId: { __rl: true, mode: 'id', value: INGEST_WORKFLOW_ID }, options: {} },
    { typeVersion: 1.2, position });
  n.retryOnFail = true;
  return n;
}
function applyNode(name, planNodeName, position) {
  return createNode(name, 'n8n-nodes-base.code',
    { mode: 'runOnceForAllItems', jsCode: applyHostedCode(planNodeName) },
    { typeVersion: 2, position });
}

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { typeVersion: 1.1, position: [-1060, 380], id: '16c06ebd-c5a4-4f0f-ac58-a60b94619953' },
);

const alreadyStored = createNode(
  'Already Stored?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: '4bd52b16-e8bc-4cac-933f-481281f3c979', leftValue: '={{ $json.WebflowId }}', rightValue: '', operator: { type: 'string', operation: 'exists', singleValue: true } },
        { id: 'b280b992-96aa-412f-848a-de8b6b1ac44b', leftValue: '={{ $json.WebflowId }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-840, 380], id: 'df150bc4-4d8b-49f7-b61b-fe50246f4284' },
);

const ifPublishable = createNode(
  'If Publishable',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: '8b48d186-2762-4bc1-b155-1089141c0834', leftValue: '={{ $json["Approved?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: '234a36d3-67c4-41fe-a77f-ffacadf02a7c', leftValue: '={{ $json.Headshot[0] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '2710f590-d96e-427e-8926-d278b9c8f67d', leftValue: '={{ $json.Testimonial }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-620, 280], id: 'a074f079-2c5c-48b4-9732-e3ac51b6e5df' },
);

const filterPublishable = createNode(
  'Filter: Publishable',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: '643e2a76-d707-4259-9f15-b7dd6e5c7e8e', leftValue: '={{ $json["Approved?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: 'bd865c1d-a997-47eb-9106-157f16ab9c11', leftValue: '={{ $json.Testimonial }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '271b1458-a25a-48fa-8a2e-e6f76a352d20', leftValue: '={{ $json.Headshot[0] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-620, 580], id: 'e351ada2-608d-43a7-97d1-9645ba01cc96' },
);

// --- Image ingest chains ---
const planUpdate = planNode('Plan Images (Update)', [-500, 180]);
const emitUpdate = emitNode('Emit Image Items (Update)', [-380, 100]);
const ingestUpdate = ingestNode('Ingest Images (Update)', [-260, 100]);
const applyUpdate = applyNode('Apply Hosted (Update)', 'Plan Images (Update)', [-140, 180]);

const planCreate = planNode('Plan Images (Create)', [-500, 680]);
const emitCreate = emitNode('Emit Image Items (Create)', [-380, 760]);
const ingestCreate = ingestNode('Ingest Images (Create)', [-260, 760]);
const applyCreate = applyNode('Apply Hosted (Create)', 'Plan Images (Create)', [-140, 680]);

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
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] || "" }}' },
        { fieldId: 'testimonial', fieldValue: '={{ $json.Testimonial }}' },
        { fieldId: 'headshot', fieldValue: '={{ ($json.Headshot || [])[0] }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  { typeVersion: 2, position: [80, 180], id: 'a78b20bc-b3ee-4c11-bf0e-b874cb70cbb1', credentials: WEBFLOW_CREDENTIAL },
);
updateWebflow.retryOnFail = true;

const deleteFromWebflow = createNode(
  'Delete from Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'deleteItem',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099d7ed2eba962dd2ae48d',
    itemId: "={{ $('Updated Testimonial in Notion').item.json.WebflowId }}",
  },
  { typeVersion: 2, position: [-400, 380], id: '465f9c2d-a411-424a-a112-9d4c9a3aa2a7', credentials: WEBFLOW_CREDENTIAL },
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
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] || "" }}' },
        { fieldId: 'testimonial', fieldValue: '={{ $json.Testimonial }}' },
        { fieldId: 'headshot', fieldValue: '={{ ($json.Headshot || [])[0] }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  { typeVersion: 2, position: [80, 680], id: 'bf2a1824-d280-49d1-b6f1-359034517fa9', credentials: WEBFLOW_CREDENTIAL },
);

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Filter: Publishable').item.json.id }}", mode: 'id' },
    propertiesUi: { propertyValues: [{ key: 'WebflowId|rich_text', textContent: '={{ $json.id }}' }] },
    options: {},
  },
  { typeVersion: 2.2, position: [300, 680], id: '32bd75a7-0857-40c3-a120-4e1d485aeb9f', credentials: NOTION_CREDENTIAL },
);

const unlinkWebflowId = createNode(
  'Notion: Unlink Webflow ID',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Updated Testimonial in Notion').item.json.id }}", mode: 'id' },
    options: {},
  },
  { typeVersion: 2.2, position: [-180, 380], id: '7b720a45-3859-4a0d-85eb-8c6259559ffb', credentials: NOTION_CREDENTIAL },
);

export default createWorkflow('Testimonials Management', {
  nodes: [
    alreadyStored, webflowCreate, storeWebflowId, updateWebflow, deleteFromWebflow,
    ifPublishable, filterPublishable, unlinkWebflowId, trigger,
    planUpdate, emitUpdate, ingestUpdate, applyUpdate,
    planCreate, emitCreate, ingestCreate, applyCreate,
  ],
  connections: [
    connect(trigger, alreadyStored),
    connect(alreadyStored, ifPublishable, 0),
    connect(alreadyStored, filterPublishable, 1),

    // Update path: publishable → resolve images → update Webflow
    connect(ifPublishable, planUpdate, 0),
    connect(planUpdate, emitUpdate),
    connect(emitUpdate, ingestUpdate),
    connect(ingestUpdate, applyUpdate),
    connect(applyUpdate, updateWebflow),
    // Not publishable → delete
    connect(ifPublishable, deleteFromWebflow, 1),
    connect(deleteFromWebflow, unlinkWebflowId),

    // Create path: publishable → resolve images → create → store id
    connect(filterPublishable, planCreate),
    connect(planCreate, emitCreate),
    connect(emitCreate, ingestCreate),
    connect(ingestCreate, applyCreate),
    connect(applyCreate, webflowCreate),
    connect(webflowCreate, storeWebflowId),
  ],
  settings: {
    executionOrder: 'v1',
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});
