/**
 * Email Subscription Manager
 *
 * Daily scheduled workflow that:
 *   1. Lists all Microsoft Graph subscriptions
 *   2. DELETEs any whose notificationUrl matches our webhook (any stale ones
 *      from prior daily runs)
 *   3. Creates two fresh subscriptions (inbox + sent items) with a 60h
 *      expiration window
 *
 * Microsoft Graph mailbox subscriptions expire after at most 4230 minutes
 * (~70 hours). Without cleanup, each daily run would leave the prior day's
 * subs alive until they expire — within a 60h overlap window we'd accumulate
 * up to 4 active subs per folder, all delivering the same notification and
 * causing 4× duplicate executions in the receiver.
 *
 * Delete + create run in parallel from the same List Subscriptions result.
 * Order doesn't matter: the new subs are valid the moment they're created,
 * and Graph will route notifications to whichever subs match.
 *
 * Both subscriptions point at the email-graph-webhook workflow's webhook URL.
 * The clientState carries a shared secret + a direction suffix
 * (`<secret>-inbox` / `<secret>-sent`) so the receiver can tell them apart.
 *
 * Companion workflow: email-graph-webhook.js (consumer).
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';
import loadEnv from '../lib/load-env.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NOTIFICATION_URL = 'https://n8n.vennfactory.com/webhook/email-graph-notify';

const CLIENT_STATE_SECRET = env.GRAPH_WEBHOOK_CLIENT_STATE || 'CHANGE_ME_VIA_OP_RUN';

const OUTLOOK_CREDENTIAL = {
  microsoftOutlookOAuth2Api: { id: 'xUInnrPuP6ogucEt', name: 'Microsoft Outlook account' },
};

// ---------------------------------------------------------------------------
// Code: from List Subscriptions response, emit one item per subscription
// whose notificationUrl matches ours (so we can DELETE it).
// ---------------------------------------------------------------------------
const PLAN_DELETES_CODE = `
const NOTIFICATION_URL = ${JSON.stringify(NOTIFICATION_URL)};
const subs = ($json.value || []);
const out = [];
for (const s of subs) {
  if (s && s.notificationUrl === NOTIFICATION_URL && s.id) {
    out.push({ json: { _subId: s.id, _resource: s.resource || '', _expiration: s.expirationDateTime || '' } });
  }
}
if (out.length === 0) {
  return [{ json: { _empty: true } }];
}
return out;
`;

// ---------------------------------------------------------------------------
// Code: always emit 2 fresh subscription-create items (inbox + sent).
// Independent of the List Subscriptions response — that's only consumed by
// the parallel delete branch.
// ---------------------------------------------------------------------------
const PLAN_CREATES_CODE = `
const SECRET = ${JSON.stringify(CLIENT_STATE_SECRET)};
const NOTIFICATION_URL = ${JSON.stringify(NOTIFICATION_URL)};

// 60 hours from now (well under the 4230 min / ~70h max)
const expiration = new Date(Date.now() + 60 * 60 * 60 * 1000).toISOString();

const subs = [
  {
    label: 'inbox',
    resource: "me/mailFolders('inbox')/messages",
    clientState: SECRET + '-inbox',
  },
  {
    label: 'sent',
    resource: "me/mailFolders('sentItems')/messages",
    clientState: SECRET + '-sent',
  },
];

return subs.map(s => ({
  json: {
    _label: s.label,
    requestBody: JSON.stringify({
      changeType: 'created',
      notificationUrl: NOTIFICATION_URL,
      resource: s.resource,
      expirationDateTime: expiration,
      clientState: s.clientState,
    }),
  },
}));
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Daily Schedule Trigger
const scheduleTrigger = createNode(
  'Daily Trigger',
  'n8n-nodes-base.scheduleTrigger',
  {
    rule: {
      interval: [{ field: 'cronExpression', expression: '0 7 * * *' }],
    },
  },
  { position: [0, 300], typeVersion: 1.2 },
);

// 2. List Subscriptions (HTTP GET to Graph)
const listSubscriptions = createNode(
  'List Subscriptions',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: 'https://graph.microsoft.com/v1.0/subscriptions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    options: {},
  },
  { position: [224, 300], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
listSubscriptions.retryOnFail = true;
listSubscriptions.maxTries = 2;
listSubscriptions.waitBetweenTries = 2000;

// --- Delete branch (top: y=100) ---

// 3a. Plan Deletes — extract IDs of subs with our notificationUrl
const planDeletes = createNode(
  'Plan Deletes',
  'n8n-nodes-base.code',
  { jsCode: PLAN_DELETES_CODE, mode: 'runOnceForAllItems' },
  { position: [448, 100], typeVersion: 2 },
);

// 3b. Has Deletes — filter out the _empty sentinel
const hasDeletes = createNode(
  'Has Deletes',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'has-delete-check',
          leftValue: '={{ $json._subId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [672, 100], typeVersion: 2.2 },
);

// 3c. Delete Subscription (HTTP DELETE, fires per item)
const deleteSubscription = createNode(
  'Delete Subscription',
  'n8n-nodes-base.httpRequest',
  {
    method: 'DELETE',
    url: '=https://graph.microsoft.com/v1.0/subscriptions/{{ $json._subId }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    options: { batching: { batch: { batchSize: 1, batchInterval: 500 } } },
  },
  { position: [896, 100], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
deleteSubscription.retryOnFail = true;
deleteSubscription.maxTries = 2;
deleteSubscription.waitBetweenTries = 2000;
// If a stale sub fails to delete (e.g. already expired and Graph 404s),
// we don't want that to block create. Continue on fail with the error item
// silently discarded — the sub will expire on its own anyway.
deleteSubscription.continueOnFail = true;

// --- Create branch (bottom: y=500) ---

// 4a. Plan Creates — always emits 2 items (inbox + sent)
const planCreates = createNode(
  'Plan Creates',
  'n8n-nodes-base.code',
  { jsCode: PLAN_CREATES_CODE, mode: 'runOnceForAllItems' },
  { position: [448, 500], typeVersion: 2 },
);

// 4b. Create Subscription (HTTP POST, fires per item)
const createSubscription = createNode(
  'Create Subscription',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://graph.microsoft.com/v1.0/subscriptions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 500 } } },
  },
  { position: [672, 500], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
createSubscription.retryOnFail = true;
createSubscription.maxTries = 2;
createSubscription.waitBetweenTries = 2000;
// No continueOnFail — a failed POST means we'd have no subscription at all,
// which is a real outage that should fire the error workflow.

export default createWorkflow('Email Subscription Manager', {
  nodes: [
    scheduleTrigger,
    listSubscriptions,
    planDeletes,
    hasDeletes,
    deleteSubscription,
    planCreates,
    createSubscription,
  ],
  connections: [
    connect(scheduleTrigger, listSubscriptions),

    // Fork from List Subscriptions: delete-stale branch (top) and
    // create-fresh branch (bottom) run in parallel.
    connect(listSubscriptions, planDeletes),
    connect(listSubscriptions, planCreates),

    // Delete branch
    connect(planDeletes, hasDeletes),
    connect(hasDeletes, deleteSubscription),

    // Create branch
    connect(planCreates, createSubscription),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
