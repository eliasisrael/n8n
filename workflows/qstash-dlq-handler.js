import { createWorkflow, createNode, connect } from '../lib/workflow.js';
import loadEnv from '../lib/load-env.js';

// =============================================================================
// QStash DLQ Handler — alerts when a QStash message permanently fails delivery
//
// Flow:
//   Webhook (POST /webhook/qstash-dlq) → Verify QStash Signature
//     → Success: Extract DLQ Info (Code) → Format Alert Email (HTML)
//       → Email (eli + eve) + Pushover (critical, priority 2)
//       → Respond 200
//     → Sig failure: Respond 401
//
// Setup:
//   Configure the QStash DLQ callback URL in the Upstash console to point to:
//     https://n8n.vennfactory.com/webhook/qstash-dlq
// =============================================================================

// Load QStash signing keys at build time
const env = loadEnv({ required: false });
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const QSTASH_CURRENT_KEY = stripQuotes(env.QSTASH_CURRENT_SIGNING_KEY) || '';
const QSTASH_NEXT_KEY = stripQuotes(env.QSTASH_NEXT_SIGNING_KEY) || '';

// Credentials
const SMTP_CREDENTIAL = {
  smtp: { id: 'oztI4hqIZ7r3dUx7', name: 'AWS SES SMTP' },
};
const PUSHOVER_CREDENTIAL = {
  pushoverApi: { id: '8yRL2WE5w6WO2crY', name: 'Pushover account' },
};
const PUSHOVER_USER_KEY = 'u8cx9933n6kq69g1uotjavhxcwri7n';
const FROM_EMAIL = 'eli@heavylift.tech';
const TO_ALL = 'eli@eliasisrael.com, eve@vennfactory.com';

// --- 1. Webhook Trigger ---
const webhook = createNode(
  'Webhook',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: 'qstash-dlq',
    responseMode: 'responseNode',
    options: {},
  },
  { position: [0, 300], typeVersion: 2.1 },
);
webhook.webhookId = 'qstash-dlq';

// --- 2. Verify QStash Signature ---
const VERIFY_QSTASH_CODE = `
const crypto = require('crypto');

const signature = $json.headers['upstash-signature'];
if (!signature) {
  throw new Error('Missing Upstash-Signature header');
}

const parts = signature.split('.');
if (parts.length !== 3) {
  throw new Error('Invalid JWT format');
}

const [headerB64, payloadB64, sigB64] = parts;
const signingInput = headerB64 + '.' + payloadB64;

const currentKey = '${QSTASH_CURRENT_KEY}';
const nextKey = '${QSTASH_NEXT_KEY}';

function verify(key) {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(signingInput);
  const expected = hmac.digest('base64url');
  return expected === sigB64;
}

if (!verify(currentKey) && !verify(nextKey)) {
  throw new Error('QStash signature verification failed');
}

const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
if (payload.iss !== 'Upstash') {
  throw new Error('Invalid issuer: ' + payload.iss);
}
if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
  throw new Error('Token expired');
}

return { json: $json };
`;

const verifySignature = createNode(
  'Verify QStash Signature',
  'n8n-nodes-base.code',
  { mode: 'runOnceForEachItem', jsCode: VERIFY_QSTASH_CODE },
  { position: [250, 300], typeVersion: 2 },
);
verifySignature.onError = 'continueErrorOutput';

// --- 3. Respond 401 (bad signature) ---
const respond401 = createNode(
  'Respond 401',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'text',
    responseBody: 'Unauthorized',
    options: { responseCode: 401 },
  },
  { position: [500, 500], typeVersion: 1.1 },
);

// --- 4. Extract DLQ Info (Code) ---
const extractDlqInfo = createNode(
  'Extract DLQ Info',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const headers = $json.headers || {};
const body = $json.body || {};

// QStash DLQ callback headers
const messageId = headers['upstash-message-id'] || 'unknown';
const topicName = headers['upstash-topic-name'] || 'unknown';
const targetUrl = headers['upstash-target-url'] || headers['upstash-url'] || 'unknown';
const retried = headers['upstash-retried'] || '0';
const responseStatus = headers['upstash-response-status'] || 'unknown';
const responseBody = headers['upstash-response-body'] || '';
const callerIp = headers['upstash-caller-ip'] || '';

// Try to extract useful context from the original message body
let entityId = '';
let databaseName = '';
try {
  if (body.entity && body.entity.id) entityId = body.entity.id;
  if (body.data && body.data.database_name) databaseName = body.data.database_name;
  if (!databaseName && body.database_name) databaseName = body.database_name;
} catch (e) {}

return {
  json: {
    messageId,
    topicName,
    targetUrl,
    retried,
    responseStatus,
    responseBody,
    entityId,
    databaseName,
    timestamp: new Date().toISOString(),
    originalBody: body,
  }
};`,
  },
  {
    typeVersion: 2,
    position: [500, 300],
  },
);

// --- 5. Format Alert Email ---
const EMAIL_HTML = `<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    .header { padding: 16px 24px; background: #d32f2f; color: #fff; }
    .header h1 { margin: 0; font-size: 18px; }
    .body { padding: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    td { padding: 8px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
    td:first-child { font-weight: 600; width: 160px; color: #555; }
    a { color: #1976d2; }
    .error-msg { background: #fff3f3; border-left: 4px solid #d32f2f; padding: 12px 16px; margin-bottom: 16px; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 600; color: #555; padding: 8px 0; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>QStash DLQ: Message permanently failed delivery</h1>
    </div>
    <div class="body">
      <div class="error-msg">A QStash message exhausted all retries and was dead-lettered. The event was NOT processed.</div>

      <table>
        <tr><td>Message ID</td><td>{{ $json.messageId }}</td></tr>
        <tr><td>Topic</td><td>{{ $json.topicName }}</td></tr>
        <tr><td>Target URL</td><td>{{ $json.targetUrl }}</td></tr>
        <tr><td>Retries</td><td>{{ $json.retried }}</td></tr>
        <tr><td>Last Response</td><td>{{ $json.responseStatus }}</td></tr>
        <tr><td>Entity ID</td><td>{{ $json.entityId || 'N/A' }}</td></tr>
        <tr><td>Database</td><td>{{ $json.databaseName || 'N/A' }}</td></tr>
        <tr><td>Timestamp</td><td>{{ $json.timestamp }}</td></tr>
      </table>

      {{ $json.responseBody ? '<p><strong>Last Response Body:</strong></p><pre>' + $json.responseBody + '</pre>' : '' }}

      <details>
        <summary>Original Message Body</summary>
        <pre>{{ JSON.stringify($json.originalBody, null, 2) }}</pre>
      </details>
    </div>
  </div>
</body>
</html>`;

const formatEmail = createNode(
  'Format Alert Email',
  'n8n-nodes-base.html',
  { html: EMAIL_HTML },
  {
    typeVersion: 1.2,
    position: [750, 300],
  },
);

// --- 6. Email (eli + eve) ---
const email = createNode(
  'Email Alert',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: FROM_EMAIL,
    toEmail: TO_ALL,
    subject: '=[DLQ] QStash delivery failed: {{ $json.topicName }} → {{ $json.targetUrl }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: { appendAttribution: false },
  },
  {
    typeVersion: 2.1,
    position: [1000, 200],
    credentials: SMTP_CREDENTIAL,
  },
);

// --- 7. Pushover (critical, priority 2) ---
const pushover = createNode(
  'Pushover Alert',
  'n8n-nodes-base.pushover',
  {
    userKey: PUSHOVER_USER_KEY,
    message: '=DLQ: QStash message failed after {{ $json.retried }} retries. Topic: {{ $json.topicName }}, Target: {{ $json.targetUrl }}. Event NOT processed.',
    priority: 2,
    additionalFields: {},
  },
  {
    typeVersion: 1,
    position: [1000, 400],
    credentials: PUSHOVER_CREDENTIAL,
  },
);

// --- 8. Respond 200 ---
const respond200 = createNode(
  'Respond 200',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'noData',
    options: { responseCode: 200 },
  },
  { position: [1250, 300], typeVersion: 1.1 },
);

// --- Connections ---
const connections = [
  connect(webhook, verifySignature),
  connect(verifySignature, extractDlqInfo, 0),   // success
  connect(verifySignature, respond401, 1),         // error
  connect(extractDlqInfo, formatEmail),
  connect(formatEmail, email),
  connect(formatEmail, pushover),
  connect(email, respond200),
  connect(pushover, respond200),
];

export default createWorkflow('QStash DLQ Handler', {
  nodes: [
    webhook,
    verifySignature,
    respond401,
    extractDlqInfo,
    formatEmail,
    email,
    pushover,
    respond200,
  ],
  connections,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    executionOrder: 'v1',
  },
  tags: [
    {
      updatedAt: '2025-02-16T13:01:39.065Z',
      createdAt: '2025-02-16T13:01:39.065Z',
      id: 'IzLCnCZq9323eiAZ',
      name: 'Production',
    },
  ],
});
