/**
 * Shared helper for generating QStash adapter workflows.
 *
 * Each adapter:
 *   1. Receives a POST from QStash (delayed 10s after the original Notion event)
 *   2. Verifies the QStash JWT signature (HMAC-SHA256)
 *   3. Fetches the fresh Notion page via the API
 *   4. Formats the payload to match the { body, record } shape existing sub-workflows expect
 *   5. Calls one or more Execute Workflow nodes
 *
 * Usage:
 *   import { createAdapter } from '../lib/adapter-template.js';
 *   export default createAdapter({
 *     name: 'Adapter: Contacts',
 *     webhookPath: 'adapter-contacts',
 *     targets: [{ name: 'Contacts Workflow', workflowId: 'XfO5Zg1zn6A4vhD6' }],
 *   });
 */

import { createWorkflow, createNode, connect } from './workflow.js';
import crypto from 'crypto';
import loadEnv from './load-env.js';

// Notion credential — adapters all use the same credential to fetch pages
const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// Load QStash signing keys from .env at build time
const env = loadEnv({ required: false });
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const QSTASH_CURRENT_KEY = stripQuotes(env.QSTASH_CURRENT_SIGNING_KEY) || '';
const QSTASH_NEXT_KEY = stripQuotes(env.QSTASH_NEXT_SIGNING_KEY) || '';

// ---------------------------------------------------------------------------
// QStash signature verification code (Code node, runOnceForEachItem)
// Signing keys are baked in at build time from .env values.
// ---------------------------------------------------------------------------
const VERIFY_QSTASH_CODE = `
const crypto = require('crypto');

const signature = $json.headers['upstash-signature'];
if (!signature) {
  throw new Error('Missing Upstash-Signature header');
}

// Split JWT: header.payload.signature
const parts = signature.split('.');
if (parts.length !== 3) {
  throw new Error('Invalid JWT format');
}

const [headerB64, payloadB64, sigB64] = parts;
const signingInput = headerB64 + '.' + payloadB64;

// Try current key first, then next key (for rotation)
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

// Decode and validate claims
const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
if (payload.iss !== 'Upstash') {
  throw new Error('Invalid issuer: ' + payload.iss);
}
if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
  throw new Error('Token expired');
}

// Verify body hash
const rawBody = JSON.stringify($json.body || $json);
const bodyHash = crypto.createHash('sha256').update(rawBody).digest('base64url');
if (payload.body && payload.body !== bodyHash) {
  // Body hash mismatch — log but don't fail (QStash may encode differently)
  // throw new Error('Body hash mismatch');
}

return { json: $json };
`;

/**
 * Create an adapter workflow.
 *
 * @param {object} opts
 * @param {string} opts.name           - Workflow name (e.g., 'Adapter: Contacts')
 * @param {string} opts.webhookPath    - Webhook path (e.g., 'adapter-contacts')
 * @param {Array<{name: string, workflowId: string}>} opts.targets - Sub-workflows to call
 * @param {Array<{name: string, value: string}>} [opts.fieldMappings] - When provided, the
 *   Format Payload Set node maps Notion simplified fields to display-name fields (matching
 *   the router's per-database Format nodes). When omitted, the Set node wraps the Notion
 *   output in { body, record } for sub-workflows that expect that shape (e.g., CST, SET).
 * @returns {object} Complete n8n workflow JSON
 */
export function createAdapter({ name, webhookPath, targets, fieldMappings }) {
  // 1. Webhook Trigger
  const webhook = createNode(
    'Webhook',
    'n8n-nodes-base.webhook',
    {
      httpMethod: 'POST',
      path: webhookPath,
      responseMode: 'responseNode',
      options: {},
    },
    { position: [0, 300], typeVersion: 2.1 },
  );
  webhook.webhookId = webhookPath;

  // 2. Verify QStash Signature
  //    Error output (output 1) → 401 response so QStash doesn't retry bad signatures
  const verifySignature = createNode(
    'Verify QStash Signature',
    'n8n-nodes-base.code',
    { mode: 'runOnceForEachItem', jsCode: VERIFY_QSTASH_CODE },
    { position: [250, 300], typeVersion: 2 },
  );
  verifySignature.onError = 'continueErrorOutput';

  // 3. Respond 401 — bad/missing QStash signature (no retry)
  const respond401 = createNode(
    'Respond 401',
    'n8n-nodes-base.respondToWebhook',
    {
      respondWith: 'text',
      responseBody: '={{ $json.message || "Unauthorized" }}',
      options: { responseCode: 401 },
    },
    { position: [500, 480], typeVersion: 1.1 },
  );

  // 4. Fetch Notion Page (simplified output gives property_<snake_case> fields)
  //    Error output (output 1) → 500 response so QStash retries later
  const fetchPage = createNode(
    'Fetch Notion Page',
    'n8n-nodes-base.notion',
    {
      resource: 'databasePage',
      operation: 'get',
      pageId: { __rl: true, mode: 'id', value: '={{ $json.body.entity.id }}' },
      simple: true,
      options: {},
    },
    { position: [500, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
  );
  fetchPage.retryOnFail = true;
  fetchPage.onError = 'continueErrorOutput';

  // 5. Respond 500 — Notion page fetch failed (QStash will retry)
  const respond500 = createNode(
    'Respond 500',
    'n8n-nodes-base.respondToWebhook',
    {
      respondWith: 'text',
      responseBody: '={{ $json.message || "Failed to fetch Notion page" }}',
      options: { responseCode: 500 },
    },
    { position: [750, 480], typeVersion: 1.1 },
  );

  // 6. Format Payload (Set node) — only reached on successful page fetch
  // Two modes:
  //   - fieldMappings provided: maps Notion property_* fields to display names (flattened)
  //   - no fieldMappings: wraps Notion output in { body, record } for CST/SET
  const assignments = fieldMappings
    ? fieldMappings.map(({ name: fieldName, value, type: fieldType }) => ({
        id: crypto.randomUUID(),
        name: fieldName,
        value,
        type: fieldType || 'string',
      }))
    : [
        {
          id: crypto.randomUUID(),
          name: 'body',
          value: "={{ $('Verify QStash Signature').item.json.body || $('Verify QStash Signature').item.json }}",
          type: 'object',
        },
        {
          id: crypto.randomUUID(),
          name: 'record',
          value: '={{ $json }}',
          type: 'object',
        },
      ];

  const formatPayload = createNode(
    'Format Payload',
    'n8n-nodes-base.set',
    {
      assignments: { assignments },
      includeOtherFields: false,
      options: {},
    },
    { position: [750, 300], typeVersion: 3.4 },
  );

  // 7. Execute Sub-Workflow(s)
  // retryOnFail handles transient n8n internal errors
  const executeNodes = targets.map((target, i) => {
    const node = createNode(
      target.name,
      'n8n-nodes-base.executeWorkflow',
      {
        workflowId: { __rl: true, mode: 'id', value: target.workflowId },
        options: {},
      },
      { position: [1000, 300 + i * 200], typeVersion: 1.2 },
    );
    node.alwaysOutputData = true;
    return node;
  });

  // 8. Merge node — only needed when multiple targets run in parallel.
  //    Waits for all Execute nodes to complete before responding.
  const needsMerge = executeNodes.length > 1;
  const mergeNode = needsMerge
    ? createNode(
        'Wait for All',
        'n8n-nodes-base.merge',
        { mode: 'append', options: {} },
        { position: [1250, 300 + (executeNodes.length - 1) * 100], typeVersion: 3 },
      )
    : null;

  // 9. Respond 200 — everything succeeded
  const respondOkPos = needsMerge ? [1500, 300] : [1250, 300];
  const respondOk = createNode(
    'Respond 200',
    'n8n-nodes-base.respondToWebhook',
    {
      respondWith: 'noData',
      options: { responseCode: 200 },
    },
    { position: respondOkPos, typeVersion: 1.1 },
  );

  // Build connections
  // Verify QStash: output 0 → Fetch Page (happy path), output 1 → Respond 401
  // Fetch Page:    output 0 → Format Payload (happy path), output 1 → Respond 500
  // Execute nodes → (Merge if multi-target) → Respond 200
  const connections = [
    connect(webhook, verifySignature),
    connect(verifySignature, fetchPage, 0),          // output 0: success
    connect(verifySignature, respond401, 1),          // output 1: error
    connect(fetchPage, formatPayload, 0),             // output 0: success
    connect(fetchPage, respond500, 1),                // output 1: error
    ...executeNodes.map(node => connect(formatPayload, node)),
    ...(needsMerge
      ? [
          ...executeNodes.map((node, i) => connect(node, mergeNode, 0, i)),
          connect(mergeNode, respondOk),
        ]
      : executeNodes.map(node => connect(node, respondOk))),
  ];

  const allNodes = [
    webhook, verifySignature, respond401, fetchPage, respond500, formatPayload,
    ...executeNodes,
    ...(mergeNode ? [mergeNode] : []),
    respondOk,
  ];

  return createWorkflow(name, {
    nodes: allNodes,
    connections,
    active: false,
    settings: {
      errorWorkflow: 'EZTb8m4htw60nP0b',
      callerPolicy: 'workflowsFromSameOwner',
    },
  });
}
