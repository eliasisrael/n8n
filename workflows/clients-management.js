/**
 * Clients Management — Sub-workflow
 *
 * Triggered by another workflow (Adapter: Clients) to sync client
 * records between Notion and Webflow.
 *
 * Logic:
 * - If already has WebflowId:
 *   - If still publishable (listed, has logo & name) → update Webflow
 *   - If no longer publishable → delete from Webflow, clear WebflowId in Notion
 * - If no WebflowId:
 *   - If active & publishable → create in Webflow, store WebflowId in Notion
 *
 * The Logo image is routed through the shared Webflow Image Ingest sub-workflow
 * (Plan → Emit → Ingest → Apply) so oversized logos are resized and every logo
 * becomes a permanent Webflow-hosted asset instead of an ephemeral Notion URL.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const WEBFLOW_CREDENTIAL = { webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' } };
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };
const INGEST_WORKFLOW_ID = 'ukgsdamtBYr76U2i';

// ---------------------------------------------------------------------------
// Image ingest chain helpers (Logo only)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { id: 'd07b22bd-4012-48bf-a5c0-ee47813a8bd2', typeVersion: 1.1, position: [-1104, 48] },
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
  { id: '5bf6a22d-e5de-4392-8186-4f23c8e0bbee', typeVersion: 2.2, position: [-880, 48] },
);

const ifPublishable = createNode(
  'If Publishable',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: 'cac228da-f1d4-4cda-9643-c6f03b7e94fc', leftValue: '={{ $json["List on site?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: '18eb3527-9708-49cf-9764-91f18c5d85f5', leftValue: '={{ $json.Logo[0] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: 'fe30fc96-2f9e-4a5b-b6a9-211488d87b0c', leftValue: '={{ $json.Name }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { id: 'f43377cc-c60c-451d-b505-8945fe5ed2ae', typeVersion: 2.2, position: [-656, -64] },
);

const activeAndPublishable = createNode(
  'Active and Publishable',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: 'ebbf7386-ddd1-4f40-b734-70c2902c14a7', leftValue: '={{ $json.Name }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '9f51f11a-fdf1-4782-8dfe-fd28aa98836e', leftValue: '={{ $json["List on site?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: 'a57bd202-d42c-46e2-ac8a-b737363d7d33', leftValue: '={{ $json.Logo[0] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { id: '92df2840-fcef-4fe1-8f99-12c57111b0e2', typeVersion: 2.2, position: [-656, 240] },
);
activeAndPublishable.retryOnFail = false;

// --- image ingest chains ---
const planUpdate = planNode('Plan Images (Update)', [-528, -160]);
const emitUpdate = emitNode('Emit Image Items (Update)', [-528, -64]);
const ingestUpdate = ingestNode('Ingest Images (Update)', [-528, 32]);
const applyUpdate = applyNode('Apply Hosted (Update)', 'Plan Images (Update)', [-528, 128]);

const planCreate = planNode('Plan Images (Create)', [-528, 336]);
const emitCreate = emitNode('Emit Image Items (Create)', [-528, 432]);
const ingestCreate = ingestNode('Ingest Images (Create)', [-528, 528]);
const applyCreate = applyNode('Apply Hosted (Create)', 'Plan Images (Create)', [-528, 624]);

const updateWebflowRecord = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a24bb8d2e2ff85e8399e',
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] }}' },
        { fieldId: 'notionid', fieldValue: '={{ $json.id }}' },
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
      ],
    },
  },
  { id: 'e60b27a1-a9b7-4687-8c3e-911fd6feb24b', typeVersion: 2, position: [-300, -160], credentials: WEBFLOW_CREDENTIAL },
);
updateWebflowRecord.retryOnFail = true;

const deleteFromWebflow = createNode(
  'Delete from Webflow',
  'n8n-nodes-base.webflow',
  { operation: 'deleteItem', siteId: '66022db75af9853636d1ce23', collectionId: '6609a24bb8d2e2ff85e8399e', itemId: '={{ $json.WebflowId }}' },
  { id: 'c2ce57b3-4c55-4fe4-98c9-efa9e5a7fe15', typeVersion: 2, position: [-448, 48], credentials: WEBFLOW_CREDENTIAL },
);
deleteFromWebflow.retryOnFail = true;

const removeWebflowIdFromNotion = createNode(
  'Remove webflow ID from notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Already Stored?').item.json.id }}", mode: 'id' },
    propertiesUi: { propertyValues: [{ key: '=WebflowId|rich_text' }] },
    options: {},
  },
  { id: 'd21b262b-175d-4ffa-8a65-d8a3f3cf4e55', typeVersion: 2.2, position: [-224, 48], credentials: NOTION_CREDENTIAL },
);
removeWebflowIdFromNotion.retryOnFail = true;

const createInWebflow = createNode(
  'Create in Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '6609a24bb8d2e2ff85e8399e',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
        { fieldId: 'logo', fieldValue: '={{ ($json.Logo || [])[0] }}' },
        { fieldId: 'notionid', fieldValue: '={{ $json.id }}' },
      ],
    },
  },
  { id: 'ee3bae75-442b-4139-a420-a28a78a24939', typeVersion: 2, position: [-300, 336], credentials: WEBFLOW_CREDENTIAL },
);
createInWebflow.retryOnFail = true;

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Active and Publishable').item.json.id }}", mode: 'id' },
    propertiesUi: { propertyValues: [{ key: '=WebflowId|rich_text', textContent: '={{ $json.id }}' }] },
    options: {},
  },
  { id: 'fcf6c34e-0532-43b4-b721-c9ece412e9a2', typeVersion: 2.2, position: [-80, 336], credentials: NOTION_CREDENTIAL },
);
storeWebflowId.retryOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Clients Management', {
  nodes: [
    alreadyStored, storeWebflowId, updateWebflowRecord, deleteFromWebflow,
    removeWebflowIdFromNotion, activeAndPublishable, createInWebflow, ifPublishable, trigger,
    planUpdate, emitUpdate, ingestUpdate, applyUpdate,
    planCreate, emitCreate, ingestCreate, applyCreate,
  ],
  connections: [
    connect(trigger, alreadyStored),
    connect(alreadyStored, ifPublishable, 0, 0),
    connect(alreadyStored, activeAndPublishable, 1, 0),

    // Publishable → resolve image → update
    connect(ifPublishable, planUpdate, 0, 0),
    connect(planUpdate, emitUpdate),
    connect(emitUpdate, ingestUpdate),
    connect(ingestUpdate, applyUpdate),
    connect(applyUpdate, updateWebflowRecord),
    // Not publishable → delete
    connect(ifPublishable, deleteFromWebflow, 1, 0),
    connect(deleteFromWebflow, removeWebflowIdFromNotion),

    // Create path: resolve image → create → store id
    connect(activeAndPublishable, planCreate),
    connect(planCreate, emitCreate),
    connect(emitCreate, ingestCreate),
    connect(ingestCreate, applyCreate),
    connect(applyCreate, createInWebflow),
    connect(createInWebflow, storeWebflowId),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['Dev', 'website'],
});
