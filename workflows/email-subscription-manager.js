/**
 * Email Subscription Manager
 *
 * Daily scheduled workflow that ensures two Microsoft Graph change-notification
 * subscriptions are active for Eve's mailbox:
 *   - inbox     (resource: me/mailFolders('inbox')/messages)
 *   - sent items (resource: me/mailFolders('sentItems')/messages)
 *
 * Microsoft Graph mailbox subscriptions expire after at most 4230 minutes
 * (~70 hours). We create fresh subscriptions every 24 hours with a 60-hour
 * expiration window, giving substantial overlap. The previous subscription
 * expires naturally — no DELETE call needed.
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
// Code: emit 2 items, one per subscription config
// ---------------------------------------------------------------------------
const EMIT_SUBSCRIPTION_CONFIGS_CODE = `
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

// 2. Emit Subscription Configs (Code)
const emitConfigs = createNode(
  'Emit Subscription Configs',
  'n8n-nodes-base.code',
  { jsCode: EMIT_SUBSCRIPTION_CONFIGS_CODE, mode: 'runOnceForAllItems' },
  { position: [224, 300], typeVersion: 2 },
);

// 3. Create Subscription (HTTP POST to Graph)
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
  { position: [448, 300], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
createSubscription.retryOnFail = true;
createSubscription.maxTries = 2;
createSubscription.waitBetweenTries = 2000;
// Don't continueOnFail — we want the error workflow to fire if subscription
// creation fails, since that's a real outage that needs human attention.

export default createWorkflow('Email Subscription Manager', {
  nodes: [scheduleTrigger, emitConfigs, createSubscription],
  connections: [
    connect(scheduleTrigger, emitConfigs),
    connect(emitConfigs, createSubscription),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
