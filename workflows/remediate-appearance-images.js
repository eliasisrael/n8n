/**
 * Remediate Appearance Images — one-off
 *
 * Fixes the June-onward appearances whose Webflow image is a 0-byte error asset
 * (from the broken Cloudinary-fetch proxy). Selects appearances that are on
 * Webflow (have a WebflowId) but have NOT yet been re-ingested by the new flow
 * (empty `Webflow Image Key`), maps them to the display-name shape the
 * Appearances Management sub-workflow expects, and calls it DIRECTLY (Execute
 * Workflow) — bypassing the Notion router so there's no fan-out cascade on the
 * trigger side. Each record runs the normal changed-path (empty key → ingest →
 * valid asset → store key).
 *
 * Fire via webhook:
 *   { "dryRun": true }            → just report the count + a sample (default)
 *   { "dryRun": false }          → run the paced remediation
 *   { "dryRun": false, "limit": 5 } → cap how many are processed
 *
 * Paced with a Wait between records; the per-record write-back still triggers
 * one settling no-photo run via the router, but that's bounded (no amplification).
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const APPEARANCES_DB_ID = '35d10c8392e64ce2adc28c03e2c97480';
const APPEARANCES_MGMT_ID = 'ceyZMOF8SKTkilhd';
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };

const BUILD_TARGETS_CODE = `
const body = ($('Remediation Webhook').first().json.body) || {};
const dryRun = body.dryRun !== false;         // default true (safe)
const limit = Number(body.limit) || 0;

const pages = $('Get All Appearances').all();
const targets = [];
for (const p of pages) {
  const j = p.json;
  const webflowId = j.property_webflow_id;
  if (!webflowId || !String(webflowId).trim()) continue;      // not on Webflow → skip
  const key = j.property_webflow_image_key;
  if (key && String(key).trim()) continue;                    // already re-ingested → skip
  targets.push({
    id: j.id,
    'Priority': j.property_priority,
    'Status': j.property_status,
    'Publication window': j.property_publication_window,
    'Master contacts': j.property_master_contacts,
    'Location': j.property_location,
    'Delivery date': j.property_delivery_date,
    'Comms type': j.property_comms_type,
    'Post-event description': j.property_post_event_description,
    'Public?': j.property_public,
    'Added': j.property_added,
    'Sticky': j.property_sticky,
    'Event name': j.property_event_name,
    'WebflowId': j.property_webflow_id,
    'Tasks': j.property_tasks,
    'Pre-event description': j.property_pre_event_description,
    'Shareable Link': j.property_shareable_link,
    'Name': j.property_name,
    'Event image': j.property_event_image,
    'Webflow Image Key': j.property_webflow_image_key,
  });
}

let list = targets;
if (limit > 0) list = list.slice(0, limit);

if (dryRun) {
  return [{ json: {
    _dryRun: true,
    totalCandidates: targets.length,
    willProcess: list.length,
    sample: list.slice(0, 8).map(t => ({
      name: t['Event name'],
      status: t.Status,
      public: t['Public?'],
      hasImage: Array.isArray(t['Event image']) && t['Event image'].length > 0,
    })),
  } }];
}

if (list.length === 0) return [{ json: { _empty: true } }];
return list.map(t => ({ json: t }));
`.trim();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const webhookTrigger = createNode(
  'Remediation Webhook',
  'n8n-nodes-base.webhook',
  { httpMethod: 'POST', path: 'remediate-appearance-images', responseMode: 'lastNode', options: {} },
  { position: [0, 300], typeVersion: 2 },
);
webhookTrigger.webhookId = 'remediate-appearance-images';

const getAppearances = createNode(
  'Get All Appearances',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: APPEARANCES_DB_ID },
    returnAll: true,
    options: {},
  },
  { position: [220, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getAppearances.retryOnFail = true;
getAppearances.maxTries = 3;
getAppearances.waitBetweenTries = 1000;

const buildTargets = createNode(
  'Build Targets',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_TARGETS_CODE },
  { position: [440, 300], typeVersion: 2 },
);

// Proceed to execute only when this is a real run (not dryRun, not empty).
const proceed = createNode(
  'Dry Run or Empty?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { id: 'dry-1', leftValue: '={{ $json._dryRun === true || $json._empty === true }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [660, 300], typeVersion: 2.2 },
);

const splitBatches = createNode(
  'Process One at a Time',
  'n8n-nodes-base.splitInBatches',
  { batchSize: 1, options: {} },
  { position: [880, 380], typeVersion: 3 },
);

const executeAppearance = createNode(
  'Re-sync Appearance',
  'n8n-nodes-base.executeWorkflow',
  { workflowId: { __rl: true, mode: 'id', value: APPEARANCES_MGMT_ID }, options: {} },
  { position: [1100, 380], typeVersion: 1.2 },
);
executeAppearance.alwaysOutputData = true;
executeAppearance.onError = 'continueRegularOutput';

const wait = createNode(
  'Wait 3s',
  'n8n-nodes-base.wait',
  { amount: 3 },
  { position: [1320, 380], typeVersion: 1.1 },
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Remediate Appearance Images', {
  nodes: [webhookTrigger, getAppearances, buildTargets, proceed, splitBatches, executeAppearance, wait],
  connections: [
    connect(webhookTrigger, getAppearances),
    connect(getAppearances, buildTargets),
    connect(buildTargets, proceed),
    // output 1 (false = real run) → paced loop
    connect(proceed, splitBatches, 1, 0),
    connect(splitBatches, executeAppearance, 1, 0),
    connect(executeAppearance, wait),
    connect(wait, splitBatches),
  ],
  settings: {
    executionOrder: 'v1',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
