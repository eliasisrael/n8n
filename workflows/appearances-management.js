/**
 * Appearances Management — Sub-workflow
 *
 * Triggered by another workflow (the Adapter: Appearances) to sync appearance
 * records between Notion and Webflow.
 *
 * Logic:
 * - If the record already has a WebflowId (already stored):
 *   - Check if it's still public, publishable, and the right comms type
 *   - If yes → update the Webflow record
 *   - If no → delete from Webflow and unlink the WebflowId in Notion
 * - If the record does NOT have a WebflowId:
 *   - Check if it's public & publishable and the right comms type
 *   - If yes → create in Webflow and store the new WebflowId in Notion
 *
 * Image handling (Path B): Notion image URLs are ephemeral, GET-only, hourly-
 * expiring signed-S3 URLs, and Webflow rejects query-string URLs — so instead
 * of handing Webflow a URL to re-host, we upload the actual bytes to Webflow's
 * Assets API (via the `webflow-image-ingest` sub-workflow) and set the photo
 * field to the resulting permanent hostedUrl.
 *
 * Fingerprint gate: the update path skips re-ingesting an unchanged image by
 * comparing the current Notion image path (URL minus its `?query`) against the
 * `Webflow Image Key` stored in Notion on the previous ingest. Only a genuinely
 * changed image triggers a new upload; Webflow also dedupes by content hash as
 * a backstop. Requires a `Webflow Image Key` (rich_text) property on the DB.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Credentials / IDs
// ---------------------------------------------------------------------------

const WEBFLOW_CREDENTIAL = {
  webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
};

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const INGEST_WORKFLOW_ID = 'ukgsdamtBYr76U2i';  // Webflow Image Ingest
const WEBFLOW_SITE_ID = '66022db75af9853636d1ce23';
const WEBFLOW_COLLECTION_ID = '66099e748dae61ccc0110673';

// ---------------------------------------------------------------------------
// Webflow field mappings
// ---------------------------------------------------------------------------

const WEBFLOW_FIELDS = [
  { fieldId: 'event-name', fieldValue: '={{ $json["Event name"] }}' },
  { fieldId: 'start', fieldValue: '={{ $json["Delivery date"].start }}' },
  { fieldId: 'end', fieldValue: '={{ $json["Delivery date"].end }}' },
  { fieldId: 'photo', fieldValue: '={{ $json["Event image"][0] }}' },
  { fieldId: 'description', fieldValue: '={{ $json["Pre-event description"] }}' },
  { fieldId: 'post-event-description', fieldValue: '={{ $json["Post-event description"] }}' },
  { fieldId: 'location', fieldValue: '={{ $json.Location }}' },
  { fieldId: 'event-link', fieldValue: '={{ $json["Shareable Link"] }}' },
  { fieldId: 'category', fieldValue: '={{ $json["Comms type"][0] }}' },
  { fieldId: 'recordid', fieldValue: '={{ $json.id }}' },
  { fieldId: 'publication-window-start', fieldValue: '={{ $json["Publication window"].start }}' },
  { fieldId: 'publication-window-end', fieldValue: '={{ $json["Publication window"].end }}' },
  { fieldId: 'sticky', fieldValue: '={{ $json.Sticky }}' },
  { fieldId: 'name', fieldValue: '={{ $json.Name }}' },
];

// Same fields minus the photo — used on the "image unchanged" update path so
// Webflow leaves the existing asset in place (no re-upload).
const WEBFLOW_FIELDS_NO_PHOTO = WEBFLOW_FIELDS.filter((f) => f.fieldId !== 'photo');

// ---------------------------------------------------------------------------
// Comms type conditions (shared between create-path filter and update-path IF)
// ---------------------------------------------------------------------------

const COMMS_TYPES = ['Appearance', 'Interview', 'Panel', 'Podcast', 'Talk', 'Webinar', 'Update'];

function makeCommsTypeConditions(ids) {
  return COMMS_TYPES.map((type, i) => ({
    id: ids[i],
    leftValue: '={{ $json["Comms type"] }}',
    rightValue: type,
    operator: { type: 'array', operation: 'contains', rightType: 'any' },
  }));
}

// ---------------------------------------------------------------------------
// Shared code
// ---------------------------------------------------------------------------

// After the ingest+merge: overwrite Event image with the permanent Webflow
// hostedUrl, and stash the fingerprint (original Notion URL minus its query) so
// it can be written back to Notion.
const SET_PHOTO_CODE = `
const item = $json;
const orig = (Array.isArray(item['Event image']) ? item['Event image'][0] : '') || '';
const key = String(orig).split('?')[0];
return { json: { ...item, 'Event image': [item.hostedUrl], _imageKey: key } };
`.trim();

// Build the { imageUrl } input the ingest sub-workflow expects, keeping the
// rest of the record for the downstream merge/passthrough.
function setImageUrlNode(name, id, position) {
  return createNode(
    name,
    'n8n-nodes-base.set',
    {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id, name: 'imageUrl', value: '={{ $json["Event image"][0] }}', type: 'string' },
        ],
      },
      options: {},
    },
    { typeVersion: 3.4, position },
  );
}

function ingestNode(name, position) {
  const node = createNode(
    name,
    'n8n-nodes-base.executeWorkflow',
    {
      workflowId: { __rl: true, mode: 'id', value: INGEST_WORKFLOW_ID },
      options: {},
    },
    { typeVersion: 1.2, position },
  );
  node.retryOnFail = true;
  return node;
}

function mergeNode(name, position) {
  return createNode(
    name,
    'n8n-nodes-base.merge',
    { mode: 'combine', combineBy: 'combineByPosition', options: {} },
    { typeVersion: 3, position },
  );
}

function setPhotoNode(name, position) {
  return createNode(
    name,
    'n8n-nodes-base.code',
    { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: SET_PHOTO_CODE },
    { typeVersion: 2, position },
  );
}

// ---------------------------------------------------------------------------
// Nodes — shared spine
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { typeVersion: 1.1, position: [-1140, -135] },
);

const alreadyStored = createNode(
  'Already Stored?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: '4bd52b16-e8bc-4cac-933f-481281f3c979',
          leftValue: '={{ $json.WebflowId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-920, -135] },
);

const stillPublicAndPublishable = createNode(
  'Still public and publishable?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: 'c165d19e-ecd3-49de-92a1-743686b380e0', leftValue: '={{ $json["Public?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: '0cf0a8f0-baeb-4c43-b113-889dee8f386d', leftValue: '={{ $json["Post-event description"] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: 'f9f8b2b6-af8d-465c-8e2b-e3cd4f007643', leftValue: '={{ $json["Pre-event description"] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: 'aacc0459-573d-4590-ba5f-bf30f1c63705', leftValue: '={{ $json["Event image"][0] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '3961d022-3952-4967-aa56-a01f9e2098a1', leftValue: '={{ $json.Status }}', rightValue: '^(Confirmed|Delivered by me|Completed.Captured)$', operator: { type: 'string', operation: 'regex' } },
        { id: '13f6344c-5b62-465c-85af-11fe8abcae7c', leftValue: '={{ $json["Publication window"] }}', rightValue: '', operator: { type: 'object', operation: 'notEmpty', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-700, -235] },
);

const publicAndPublishable = createNode(
  'Public & Publishable',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: '13d7e12f-fdc4-4c8b-9c70-10d02dc8a0d3', leftValue: '={{ $json["Public?"] }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
        { id: '522df334-7e76-4b66-846e-d2ee1727a75e', leftValue: '={{ $json.Status }}', rightValue: '(Confirmed|Delivered by me|Completed.Captured)', operator: { type: 'string', operation: 'regex' } },
        { id: '32565c46-3760-4bab-808f-d97017818f10', leftValue: '={{ $json["Event image"] }}', rightValue: '', operator: { type: 'array', operation: 'notEmpty', singleValue: true } },
        { id: '5016eb88-8e37-414c-b6d3-3e10b8b39959', leftValue: '={{ $json["Pre-event description"] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '62842c31-2e41-4307-ae2b-0c03f4d9dae3', leftValue: '={{ $json["Post-event description"] }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        { id: '0f4f917a-d6af-4393-bc7c-0feae08dce34', leftValue: '={{ $json["Publication window"] }}', rightValue: '', operator: { type: 'object', operation: 'exists', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-700, 140] },
);
publicAndPublishable.alwaysOutputData = false;

const filterCommsType = createNode(
  'Filter: Comms Type',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: makeCommsTypeConditions([
        '1344d39a-e994-41da-8d2a-2b75a23612a3', '2ce770a0-4c8e-4d49-ae61-6cc0e50ad5c8',
        'fc4e650d-1f74-47de-9bf5-f7586e6fd1a3', 'c96cacd8-ea09-46f0-9a80-931483343558',
        '887f8487-b9de-420e-9a4f-c44757acc3f1', '2f10b9cb-9148-4866-94fa-e8e1ce3eec7b',
        '498645c2-96f9-4e96-adac-17a6b98002f9',
      ]),
      combinator: 'or',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-480, 140] },
);

const stillRightCommsType = createNode(
  'Still right comms type?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: makeCommsTypeConditions([
        'b5d8059d-c864-483a-85c1-64a506a25f40', '66ebf368-9374-4145-b1da-3aaebf8c7398',
        '7d6feeac-11a7-4163-9827-c14aebc5ae7e', '8837709f-fdbb-463f-98c9-e95f5d40232c',
        'e7478b0f-a371-425c-a12f-0a306643ebec', '14faf27b-d875-4f24-9049-eeb05a219abe',
        '53c6c988-9e76-4633-9ff9-7a3a968708a4',
      ]),
      combinator: 'or',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-480, -310] },
);

// ---------------------------------------------------------------------------
// Create path
// ---------------------------------------------------------------------------

const setImageUrlCreate = setImageUrlNode('Set imageUrl (Create)', 'a1000000-0000-4000-8000-000000000001', [-260, 140]);
const ingestCreate = ingestNode('Ingest Image (Create)', [-40, 60]);
const mergeCreate = mergeNode('Merge Ingest (Create)', [180, 140]);
const setPhotoCreate = setPhotoNode('Set Photo (Create)', [400, 140]);

const webflowCreate = createNode(
  'Webflow',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: WEBFLOW_SITE_ID,
    collectionId: WEBFLOW_COLLECTION_ID,
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_FIELDS },
  },
  { typeVersion: 2, position: [620, 140], credentials: WEBFLOW_CREDENTIAL },
);
webflowCreate.retryOnFail = true;

const storeWebflowId = createNode(
  'Store Webflow ID in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: '={{ $json.fieldData.recordid }}', mode: 'id' },
    propertiesUi: {
      propertyValues: [
        { key: 'WebflowId|rich_text', textContent: '={{ $json.id }}' },
        { key: 'Webflow Image Key|rich_text', textContent: "={{ $('Set Photo (Create)').item.json._imageKey }}" },
      ],
    },
    options: {},
  },
  { typeVersion: 2.2, position: [840, 140], credentials: NOTION_CREDENTIAL },
);
storeWebflowId.retryOnFail = true;

// ---------------------------------------------------------------------------
// Update path — fingerprint gate
// ---------------------------------------------------------------------------

const imageChanged = createNode(
  'Image Changed?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'img-change-1',
          leftValue: "={{ ($json['Event image'] && $json['Event image'][0] ? $json['Event image'][0].split('?')[0] : '') }}",
          rightValue: "={{ $json['Webflow Image Key'] || '' }}",
          operator: { type: 'string', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-260, -360] },
);

const setImageUrlUpdate = setImageUrlNode('Set imageUrl (Update)', 'a2000000-0000-4000-8000-000000000002', [-40, -440]);
const ingestUpdate = ingestNode('Ingest Image (Update)', [180, -520]);
const mergeUpdate = mergeNode('Merge Ingest (Update)', [400, -440]);
const setPhotoUpdate = setPhotoNode('Set Photo (Update)', [620, -440]);

const updateWebflowWithPhoto = createNode(
  'Update Webflow Record',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: WEBFLOW_SITE_ID,
    collectionId: WEBFLOW_COLLECTION_ID,
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_FIELDS },
  },
  { typeVersion: 2, position: [840, -440], credentials: WEBFLOW_CREDENTIAL },
);
updateWebflowWithPhoto.retryOnFail = true;

const storeKeyUpdate = createNode(
  'Store Image Key in Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Set Photo (Update)').item.json.id }}", mode: 'id' },
    propertiesUi: {
      propertyValues: [
        { key: 'Webflow Image Key|rich_text', textContent: "={{ $('Set Photo (Update)').item.json._imageKey }}" },
      ],
    },
    options: {},
  },
  { typeVersion: 2.2, position: [1060, -440], credentials: NOTION_CREDENTIAL },
);
storeKeyUpdate.retryOnFail = true;

// Unchanged image → update everything except the photo (Webflow keeps the asset)
const updateWebflowNoPhoto = createNode(
  'Update Webflow (No Photo)',
  'n8n-nodes-base.webflow',
  {
    operation: 'update',
    siteId: WEBFLOW_SITE_ID,
    collectionId: WEBFLOW_COLLECTION_ID,
    itemId: '={{ $json.WebflowId }}',
    live: true,
    fieldsUi: { fieldValues: WEBFLOW_FIELDS_NO_PHOTO },
  },
  { typeVersion: 2, position: [180, -300], credentials: WEBFLOW_CREDENTIAL },
);
updateWebflowNoPhoto.retryOnFail = true;

// ---------------------------------------------------------------------------
// Delete path (unchanged)
// ---------------------------------------------------------------------------

const deleteFromWebflow = createNode(
  'Delete from Webflow',
  'n8n-nodes-base.webflow',
  { operation: 'deleteItem', siteId: WEBFLOW_SITE_ID, collectionId: WEBFLOW_COLLECTION_ID, itemId: '={{ $json.WebflowId }}' },
  { typeVersion: 2, position: [-260, -140], credentials: WEBFLOW_CREDENTIAL },
);
deleteFromWebflow.retryOnFail = true;
deleteFromWebflow.onError = 'continueErrorOutput';

const unlinkWebflowId = createNode(
  'Unlink Webflow ID',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: '={{ $json.id }}', mode: 'id' },
    propertiesUi: { propertyValues: [{ key: 'WebflowId|rich_text', textContent: '={{ "" }}' }] },
    options: {},
  },
  { typeVersion: 2.2, position: [160, -240], credentials: NOTION_CREDENTIAL },
);
unlinkWebflowId.retryOnFail = true;

const filter404 = createNode(
  'Filter',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: '221386e0-fa03-477e-a499-fc126920f0f5', leftValue: '={{ $json.error.cause.status }}', rightValue: 404, operator: { type: 'number', operation: 'equals' } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { typeVersion: 2.2, position: [-40, -60] },
);

const unlinkWebflowId1 = createNode(
  'Unlink Webflow ID1',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: { __rl: true, value: "={{ $('Still public and publishable?').item.json.id }}", mode: 'id' },
    propertiesUi: { propertyValues: [{ key: 'WebflowId|rich_text', textContent: '={{ "" }}' }] },
    options: {},
  },
  { typeVersion: 2.2, position: [160, -60], credentials: NOTION_CREDENTIAL },
);
unlinkWebflowId1.retryOnFail = true;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Appearances Management', {
  nodes: [
    trigger, alreadyStored, stillPublicAndPublishable, publicAndPublishable,
    filterCommsType, stillRightCommsType,
    // create path
    setImageUrlCreate, ingestCreate, mergeCreate, setPhotoCreate, webflowCreate, storeWebflowId,
    // update path
    imageChanged, setImageUrlUpdate, ingestUpdate, mergeUpdate, setPhotoUpdate,
    updateWebflowWithPhoto, storeKeyUpdate, updateWebflowNoPhoto,
    // delete path
    deleteFromWebflow, unlinkWebflowId, filter404, unlinkWebflowId1,
  ],
  connections: [
    connect(trigger, alreadyStored),
    connect(alreadyStored, stillPublicAndPublishable, 0, 0),
    connect(alreadyStored, publicAndPublishable, 1, 0),

    // Create path
    connect(publicAndPublishable, filterCommsType),
    connect(filterCommsType, setImageUrlCreate),
    connect(setImageUrlCreate, ingestCreate),
    connect(ingestCreate, mergeCreate, 0, 0),
    connect(setImageUrlCreate, mergeCreate, 0, 1),
    connect(mergeCreate, setPhotoCreate),
    connect(setPhotoCreate, webflowCreate),
    connect(webflowCreate, storeWebflowId, 0, 0),

    // Update path
    connect(stillPublicAndPublishable, stillRightCommsType, 0, 0),
    connect(stillPublicAndPublishable, deleteFromWebflow, 1, 0),
    connect(stillRightCommsType, imageChanged, 0, 0),
    connect(stillRightCommsType, deleteFromWebflow, 1, 0),

    // Update — image changed → ingest → update with photo → store key
    connect(imageChanged, setImageUrlUpdate, 0, 0),
    connect(setImageUrlUpdate, ingestUpdate),
    connect(ingestUpdate, mergeUpdate, 0, 0),
    connect(setImageUrlUpdate, mergeUpdate, 0, 1),
    connect(mergeUpdate, setPhotoUpdate),
    connect(setPhotoUpdate, updateWebflowWithPhoto),
    connect(updateWebflowWithPhoto, storeKeyUpdate),

    // Update — image unchanged → update without photo
    connect(imageChanged, updateWebflowNoPhoto, 1, 0),

    // Delete path
    connect(deleteFromWebflow, unlinkWebflowId, 0, 0),
    connect(deleteFromWebflow, filter404, 1, 0),
    connect(filter404, unlinkWebflowId1),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});
