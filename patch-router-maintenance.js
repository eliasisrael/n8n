/**
 * patch-router-maintenance.js
 *
 * Insert a maintenance mode gate into the Notion Webhook Router.
 *
 * Inserts 2 nodes between "Webhook" and "Calculate Signature":
 *   1. Maintenance Check (Code) — fetches Upstash Redis GET n8n:maintenance,
 *      sets _maintenance flag on item, preserves original $json
 *   2. If Maintenance? (IF) — gates on _maintenance flag:
 *      true  → Success: Respond to Webhook (200, drop event)
 *      false → Calculate Signature (continue normal flow)
 *
 * Usage:
 *   node patch-router-maintenance.js             # apply changes
 *   node patch-router-maintenance.js --dry-run   # preview without applying
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import loadEnv from './lib/load-env.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = new URL('.', import.meta.url).pathname;
const env = loadEnv({ required: true });
const BASE_URL = env.N8N_BASE_URL;
const API_KEY = env.N8N_API_KEY;
const ROUTER_ID = '6kSboH0MtIOedeja';
const BACKUP_PATH = join(ROOT, 'server', 'notion-webhook-router-pre-maintenance.json');

function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

const UPSTASH_URL = stripQuotes(env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = stripQuotes(env.UPSTASH_REDIS_REST_TOKEN);

const dryRun = process.argv.includes('--dry-run');

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers (reused from patch-router-debounce.js)
// ---------------------------------------------------------------------------
const ALLOWED_NODE_KEYS = new Set([
  'id', 'name', 'type', 'typeVersion', 'position', 'parameters',
  'credentials', 'disabled', 'onError', 'retryOnFail', 'executeOnce',
  'continueOnFail', 'alwaysOutputData', 'notesInFlow', 'notes', 'webhookId',
]);

function cleanNode(node) {
  const clean = {};
  for (const [key, value] of Object.entries(node)) {
    if (ALLOWED_NODE_KEYS.has(key)) clean[key] = value;
  }
  return clean;
}

function toApiBody(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes.map(cleanNode),
    connections: wf.connections,
    settings: wf.settings,
  };
}

// ---------------------------------------------------------------------------
// Maintenance node names (for idempotent cleanup)
// ---------------------------------------------------------------------------
const MAINTENANCE_NAMES = new Set([
  'Maintenance Check',
  'If Maintenance?',
  'Restore Event (Maintenance)',
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Fetch live router
console.log(`Fetching router ${ROUTER_ID} from ${BASE_URL}...`);
const getRes = await fetch(new URL(`/api/v1/workflows/${ROUTER_ID}`, BASE_URL), {
  headers: { 'X-N8N-API-KEY': API_KEY },
});
if (!getRes.ok) {
  console.error(`GET failed: ${getRes.status} ${await getRes.text()}`);
  process.exit(1);
}
const router = await getRes.json();
console.log(`  Fetched "${router.name}" (${router.nodes.length} nodes)\n`);

// 2. Clean up any previous maintenance patch (idempotent)
const beforeCount = router.nodes.length;
router.nodes = router.nodes.filter(n => !MAINTENANCE_NAMES.has(n.name));
if (beforeCount > router.nodes.length) {
  console.log(`  Cleaned up ${beforeCount - router.nodes.length} existing maintenance node(s)`);
}
for (const name of MAINTENANCE_NAMES) delete router.connections[name];

// 3. Find anchor nodes
const webhookNode = router.nodes.find(n => n.name === 'Webhook');
const calcSigNode = router.nodes.find(n => n.name === 'Calculate Signature');
const respondNode = router.nodes.find(n => n.name === 'Success: Respond to Webhook');
if (!webhookNode || !calcSigNode || !respondNode) {
  console.error('Could not find anchor nodes (Webhook, Calculate Signature, or Success: Respond to Webhook)');
  process.exit(1);
}

console.log(`  Anchor: Webhook at [${webhookNode.position}]`);
console.log(`  Anchor: Calculate Signature at [${calcSigNode.position}]`);
console.log(`  Anchor: Success: Respond to Webhook at [${respondNode.position}]`);

// 4. Calculate positions for new nodes
// Webhook is at x=-1104, Calculate Signature at x=-880 (gap=224px)
// We need 3 new nodes (HTTP Request, IF, Restore), so shift right accordingly
const webhookX = webhookNode.position[0];
const webhookY = webhookNode.position[1];
const SPACING = 224;
const SHIFT = SPACING * 3; // 672px for 3 new nodes

// Shift all nodes at or to the right of Calculate Signature
const shiftThreshold = calcSigNode.position[0];
for (const node of router.nodes) {
  if (node.position[0] >= shiftThreshold) {
    node.position = [node.position[0] + SHIFT, node.position[1]];
  }
}
console.log(`  Shifted nodes right by ${SHIFT}px`);

// New node positions
const maintenanceCheckPos = [webhookX + SPACING, webhookY];
const ifMaintenancePos = [webhookX + SPACING * 2, webhookY];
const restoreEventPos = [webhookX + SPACING * 3, webhookY];

// 5. Create the maintenance gate nodes

// 5a. Maintenance Check (HTTP Request) — GET Redis key, replaces $json with response
const maintenanceCheckNode = {
  parameters: {
    method: 'GET',
    url: `${UPSTASH_URL}/GET/n8n:maintenance`,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: `Bearer ${UPSTASH_TOKEN}` },
      ],
    },
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: maintenanceCheckPos,
  id: crypto.randomUUID(),
  name: 'Maintenance Check',
};

// 5b. If Maintenance? (IF node) — result is non-null when maintenance is active
const ifMaintenanceNode = {
  parameters: {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.result }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: ifMaintenancePos,
  id: crypto.randomUUID(),
  name: 'If Maintenance?',
};

// 5c. Restore Event (Code) — HTTP Request replaced $json with Redis response;
// restore original webhook payload via back-reference so downstream sees original data
const restoreEventNode = {
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: [
      "const orig = $('Webhook').item.json;",
      'return { json: orig };',
    ].join('\n'),
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: restoreEventPos,
  id: crypto.randomUUID(),
  name: 'Restore Event (Maintenance)',
};

router.nodes.push(maintenanceCheckNode, ifMaintenanceNode, restoreEventNode);
console.log('  Added nodes: Maintenance Check, If Maintenance?, Restore Event (Maintenance)');

// 6. Wire connections

// Webhook → Maintenance Check (replaces old Webhook → Calculate Signature)
router.connections['Webhook'] = {
  main: [[{ node: 'Maintenance Check', type: 'main', index: 0 }]],
};

// Maintenance Check → If Maintenance?
router.connections['Maintenance Check'] = {
  main: [[{ node: 'If Maintenance?', type: 'main', index: 0 }]],
};

// If Maintenance?
//   true (output 0)  → Success: Respond to Webhook (drop event, respond 200)
//   false (output 1) → Restore Event (Maintenance) (restore original payload)
router.connections['If Maintenance?'] = {
  main: [
    [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
    [{ node: 'Restore Event (Maintenance)', type: 'main', index: 0 }],
  ],
};

// Restore Event (Maintenance) → Calculate Signature (continue normal flow)
router.connections['Restore Event (Maintenance)'] = {
  main: [[{ node: 'Calculate Signature', type: 'main', index: 0 }]],
};

console.log('  Wired: Webhook → Maintenance Check → If Maintenance?');
console.log('  Wired: If Maintenance? (true) → Success: Respond to Webhook');
console.log('  Wired: If Maintenance? (false) → Restore Event → Calculate Signature\n');

// 7. Save backup
writeFileSync(BACKUP_PATH, JSON.stringify(router, null, 2));
console.log(`  Saved backup to ${BACKUP_PATH}`);

// 8. Push to server
if (dryRun) {
  console.log('\n  [dry-run] Would PUT updated router — no changes made.');
  process.exit(0);
}

console.log(`  Pushing updated router to ${BASE_URL}...`);
const putRes = await fetch(new URL(`/api/v1/workflows/${ROUTER_ID}`, BASE_URL), {
  method: 'PUT',
  headers: {
    'X-N8N-API-KEY': API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(toApiBody(router)),
});

if (!putRes.ok) {
  const body = await putRes.text();
  console.error(`  PUT failed (${putRes.status}): ${body}`);
  process.exit(1);
}

const result = await putRes.json();
console.log(`  Router updated successfully (${result.nodes.length} nodes)`);
console.log('\nDone. Verify in the n8n UI that the maintenance gate appears between');
console.log('"Webhook" and "Calculate Signature".');
