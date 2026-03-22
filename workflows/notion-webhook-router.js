/**
 * Notion Webhook Router
 *
 * Central router for all Notion webhook events. Receives webhooks,
 * verifies the HMAC-SHA256 signature, deduplicates via Redis pipeline,
 * looks up the target QStash topic by database ID, and publishes
 * routable events to QStash for downstream adapter processing.
 *
 * Flow:
 *   1. Webhook receives POST from Notion
 *   2. Maintenance check via Redis — if active, respond 200 and drop
 *   3. Calculate HMAC-SHA256 signature and verify against header
 *   4. Filter out untrusted payloads (respond 200, drop)
 *   5. Filter out *.deleted events (respond 200, drop)
 *   6. Filter out non-database events (respond 200, drop)
 *   7. Parallel: fetch database metadata + build Redis pipeline
 *   8. Redis pipeline: SET debounce key (NX EX 10) + GET topic name
 *   9. Gate on _isNew + _topicName — non-routable events dropped
 *  10. Publish to QStash with 10s delay
 *  11. Respond 200 (success) or 503 (error for retry)
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Notion webhook verification secret — baked in at build time.
const NOTION_WEBHOOK_SECRET = process.env.NOTION_WEBHOOK_SECRET;
if (!NOTION_WEBHOOK_SECRET) {
  throw new Error('Missing NOTION_WEBHOOK_SECRET in .env');
}

// Upstash Redis REST URL for maintenance check + debounce pipeline.
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const UPSTASH_URL = stripQuotes(process.env.UPSTASH_REDIS_REST_URL);
if (!UPSTASH_URL) {
  throw new Error('Missing UPSTASH_REDIS_REST_URL in .env');
}

// QStash URL for delayed delivery to adapter workflows.
const QSTASH_URL = stripQuotes(process.env.QSTASH_URL);
if (!QSTASH_URL) {
  throw new Error('Missing QSTASH_URL in .env');
}

// n8n server credentials (httpHeaderAuth type).
const UPSTASH_CREDENTIAL = { httpHeaderAuth: { id: 'mxEZyivdASDcGG7S', name: 'Upstash Redis (Fulcrum)' } };
const QSTASH_CREDENTIAL = { httpHeaderAuth: { id: '31uVSX3kLzvq1xiT', name: 'QStash (Fulcrum)' } };
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };

// Webhook path — must match the registered Notion webhook URL.
const WEBHOOK_PATH = '8013d774-5425-45ab-ae1b-95b43da9e583';

// DLQ callback URL for failed QStash deliveries.
const DLQ_CALLBACK_URL = 'https://n8n.vennfactory.com/webhook/qstash-dlq';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const webhook = createNode(
  'Webhook',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: WEBHOOK_PATH,
    responseMode: 'responseNode',
    options: {},
  },
  { position: [-1104, 400], typeVersion: 2, id: 'b0b96bbb-93b9-43c7-a9b2-b53c112d362b' },
);
webhook.webhookId = WEBHOOK_PATH;

// ---------------------------------------------------------------------------
// Maintenance gate
// ---------------------------------------------------------------------------

const maintenanceCheck = createNode(
  'Maintenance Check',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: `${UPSTASH_URL}/GET/n8n:maintenance`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: {},
  },
  { position: [-880, 400], typeVersion: 4.2, credentials: UPSTASH_CREDENTIAL, id: '73a8f38d-da99-4234-943b-ab101e48909b' },
);

const ifMaintenance = createNode(
  'If Maintenance?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: '59c62065-ba9d-43ab-86d0-38141fd94da2',
        leftValue: '={{ $json.result }}',
        rightValue: '',
        operator: { type: 'string', operation: 'empty', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [-656, 400], typeVersion: 2.2, id: '07e608cd-cd50-48b1-a65a-19c345fea3d3' },
);

// Restore original webhook payload after the maintenance HTTP Request replaced $json.
const restoreEventMaintenance = createNode(
  'Restore Event (Maintenance)',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: "const orig = $('Webhook').item.json;\nreturn { json: orig };",
  },
  { position: [-432, 400], typeVersion: 2, id: 'bac16392-84c9-44ad-8448-49af4b8110a8' },
);

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

const calculateSignature = createNode(
  'Calculate Signature',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: 'let crypto = require("crypto");\n'
      + '// Retrieve the `verificationToken` from initial request\n'
      + `const verificationToken = "${NOTION_WEBHOOK_SECRET}"\n`
      + '\n'
      + '// This body should come from your request body for subsequent validations\n'
      + 'const body = $input.item.json.body;\n'
      + '\n'
      + 'const calculatedSignature = `sha256=${crypto.createHmac("sha256", verificationToken).update(JSON.stringify(body)).digest("hex")}`\n'
      + '\n'
      + 'const isTrustedPayload = \n'
      + '  calculatedSignature === $input.item.json.headers["x-notion-signature"];\n'
      + '\n'
      + '$input.item.json.calculatedSig = calculatedSignature;\n'
      + "// Add a new field called 'myNewField' to the JSON of the item\n"
      + '$input.item.json.tustedPayload = isTrustedPayload;\n'
      + '\n'
      + 'return $input.item;',
  },
  { position: [-208, 400], typeVersion: 2, id: '7c2d48be-d0eb-4fb2-857f-ef98f8571b34' },
);

const trustedPayload = createNode(
  'Trusted Payload?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: '90aef9eb-0c9a-4e2b-9f1c-136dade583e5',
        leftValue: '={{ $json.tustedPayload }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [16, 400], typeVersion: 2.2, id: '96f43fe3-5545-48de-94fc-01ea190987db' },
);

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

const skipDeletedEvents = createNode(
  'Skip Deleted Events',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'dae855b7-adff-4bac-88f9-c7f92011f895',
        leftValue: '={{ $json.body.type }}',
        rightValue: '.deleted',
        operator: { type: 'string', operation: 'notEndsWith' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [240, 400], typeVersion: 2.2, id: 'a7dd73c2-7581-4900-97de-cc3c51bca13b' },
);

const stickyNote = createNode(
  'Sticky Note',
  'n8n-nodes-base.stickyNote',
  {
    content: '**page.deleted events are dropped here.**\n\nNo sub-workflow handles deletion propagation today. Letting these through would cause stale data to leak into downstream systems (e.g., Mailchimp, Webflow).\n\nSee LESSONS.md → Future Work for the NOTIONID linkage plan that would enable proper deletion handling.',
    height: 170,
    width: 340,
    color: 4,
  },
  { position: [128, 160], typeVersion: 1, id: '5c10766a-91eb-4a5c-a4a4-fe7f98baee9d' },
);

const isDatabaseEvent = createNode(
  'Is Database Event?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: '2e702d27-fea5-44b9-9649-2016c9901d1e',
        leftValue: '={{ $json.body.data.parent.type }}',
        rightValue: 'database',
        operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  { position: [464, 400], typeVersion: 2.2, id: '711efd0c-99b5-418c-9535-30b0f1dc49f7' },
);

// ---------------------------------------------------------------------------
// Parallel branches from Is Database Event?
// ---------------------------------------------------------------------------

// Branch A: Fetch database metadata for execution annotation
const fetchDatabase = createNode(
  'Fetch Database',
  'n8n-nodes-base.notion',
  {
    resource: 'database',
    databaseId: {
      __rl: true,
      value: '={{ $json.body.data.parent.id }}',
      mode: 'id',
    },
  },
  { position: [688, 200], typeVersion: 2.2, credentials: NOTION_CREDENTIAL, id: '8dcdcb0e-2a2a-4ba8-842c-1289b2b65142' },
);
fetchDatabase.continueOnFail = true;

const executionData = createNode(
  'Execution Data',
  'n8n-nodes-base.executionData',
  {
    dataToSave: {
      values: [
        { key: 'database', value: '={{ $json.name }}' },
        { key: 'databaseId', value: '={{ $json.id }}' },
        { key: 'url', value: '={{ $json.url }}' },
      ],
    },
  },
  { position: [912, 200], typeVersion: 1.1, id: 'b098d240-a289-4504-bdb5-1c7ac8ee8f1f' },
);

// Branch B: Redis pipeline for debounce + topic lookup
const buildRedisPipeline = createNode(
  'Build Redis Pipeline',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: 'const entityId = $json.body.entity.id;\nconst dbId = $json.body.data.parent.id;\n\nreturn {\n  json: {\n    ...$json,\n    _pipelineBody: [\n      ["SET", `debounce:page:${entityId}`, "1", "EX", "10", "NX"],\n      ["GET", `dbtopic:${dbId}`]\n    ],\n  }\n};',
  },
  { position: [688, 400], typeVersion: 2, id: '205ee1c0-0e1c-4a79-a8b7-dabd1de35201' },
);

const redisPipeline = createNode(
  'Redis Pipeline',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `${UPSTASH_URL}/pipeline`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json._pipelineBody) }}',
    options: {},
  },
  { position: [912, 400], typeVersion: 4.2, credentials: UPSTASH_CREDENTIAL, id: '53eac67f-7c8f-4bf7-bb3a-1764f803eb63' },
);
redisPipeline.retryOnFail = true;
redisPipeline.maxTries = 3;
redisPipeline.waitBetweenTries = 2000;
redisPipeline.onError = 'continueErrorOutput';

// ---------------------------------------------------------------------------
// Result extraction and routing
// ---------------------------------------------------------------------------

const restoreEventExtract = createNode(
  'Restore Event + Extract Results',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: "const orig = $('Build Redis Pipeline').first().json;\nconst { _pipelineBody, ...event } = orig;\n\n// Upstash pipeline returns [{result: \"OK\"}, {result: \"topic-name\"}]\n// n8n splits the array into separate items\nconst items = $input.all();\nconst isNew = items[0]?.json?.result ?? null;       // \"OK\" or null\nconst topicName = items[1]?.json?.result ?? null;   // topic name or null\n\nreturn [{\n  json: {\n    ...event,\n    _isNew: isNew,\n    _topicName: topicName,\n  }\n}];",
  },
  { position: [1136, 400], typeVersion: 2, id: 'b95cbe3c-5040-487d-ab0f-7953fe19e0dc' },
);

const isRoutableEvent = createNode(
  'Is Routable Event?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: '55a2e09d-c4df-43b7-98ad-d57764ba8602',
          leftValue: '={{ $json._isNew }}',
          rightValue: 'OK',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        },
        {
          id: '40377ca3-a941-4251-907b-bcb2524d2259',
          leftValue: '={{ $json._topicName }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', name: 'filter.operator.notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1360, 400], typeVersion: 2.2, id: '6f4af5b8-5331-49b6-ad5e-d8d742930644' },
);

// ---------------------------------------------------------------------------
// QStash publish
// ---------------------------------------------------------------------------

const publishToQStash = createNode(
  'Publish to QStash',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `=${QSTASH_URL}/v2/publish/{{ $json._topicName }}`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Upstash-Delay', value: '10s' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Upstash-Failure-Callback', value: DLQ_CALLBACK_URL },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: {},
  },
  { position: [1584, 400], typeVersion: 4.2, credentials: QSTASH_CREDENTIAL, id: '704d9c5a-ca95-41cc-917c-197d75961697' },
);
publishToQStash.retryOnFail = true;
publishToQStash.maxTries = 3;
publishToQStash.waitBetweenTries = 2000;
publishToQStash.onError = 'continueErrorOutput';

// ---------------------------------------------------------------------------
// Response nodes
// ---------------------------------------------------------------------------

const successRespond = createNode(
  'Success: Respond to Webhook',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [1808, 680], typeVersion: 1.1, id: 'fbd5f4ef-da44-41e2-b204-7752dae26b18' },
);

const errorRespond = createNode(
  'Error: Respond to Webhook',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 503 },
  },
  { position: [1808, 880], typeVersion: 1.1, id: '30e568b1-9ed4-4a74-991c-884f623ad789' },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Webhook Router', {
  nodes: [
    webhook,
    maintenanceCheck, ifMaintenance, restoreEventMaintenance,
    calculateSignature, trustedPayload,
    skipDeletedEvents, stickyNote,
    isDatabaseEvent,
    fetchDatabase, executionData,
    buildRedisPipeline, redisPipeline,
    restoreEventExtract, isRoutableEvent,
    publishToQStash,
    successRespond, errorRespond,
  ],
  connections: [
    // Maintenance gate
    connect(webhook, maintenanceCheck),
    connect(maintenanceCheck, ifMaintenance),
    connect(ifMaintenance, restoreEventMaintenance, 0, 0),    // out0: empty (not in maintenance) → continue
    connect(ifMaintenance, successRespond, 1, 0),             // out1: not empty (maintenance on) → drop

    // Signature verification
    connect(restoreEventMaintenance, calculateSignature),
    connect(calculateSignature, trustedPayload),
    connect(trustedPayload, skipDeletedEvents, 0, 0),         // out0: trusted → continue
    connect(trustedPayload, successRespond, 1, 0),            // out1: untrusted → drop

    // Event filtering
    connect(skipDeletedEvents, isDatabaseEvent, 0, 0),        // out0: not deleted → continue
    connect(skipDeletedEvents, successRespond, 1, 0),         // out1: deleted → drop

    // Database event check — parallel branches on true
    connect(isDatabaseEvent, buildRedisPipeline, 0, 0),       // out0: database event → Redis pipeline
    connect(isDatabaseEvent, fetchDatabase, 0, 0),            // out0: database event → fetch metadata
    connect(isDatabaseEvent, successRespond, 1, 0),           // out1: non-database → drop

    // Fetch Database → Execution Data (annotation branch)
    connect(fetchDatabase, executionData),

    // Redis pipeline → result extraction → routing
    connect(buildRedisPipeline, redisPipeline),
    connect(redisPipeline, restoreEventExtract, 0, 0),        // out0: success → extract results
    connect(redisPipeline, errorRespond, 1, 0),               // out1: error → 503

    connect(restoreEventExtract, isRoutableEvent),
    connect(isRoutableEvent, publishToQStash, 0, 0),          // out0: routable → publish
    connect(isRoutableEvent, successRespond, 1, 0),           // out1: not routable → drop

    // QStash publish result
    connect(publishToQStash, successRespond, 0, 0),           // out0: success → 200
    connect(publishToQStash, errorRespond, 1, 0),             // out1: error → 503
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: [{ id: 'IzLCnCZq9323eiAZ', name: 'Production' }],
});
