/**
 * patch-router-debounce.js
 *
 * Phase 1: Insert a Redis debounce gate into the Notion Webhook Router.
 *
 * Inserts 4 nodes between "Skip Deleted Events" and "Sort by Timestamp":
 *   1. Build Debounce Key (Code) — extracts entity ID, builds Redis command, preserves original $json
 *   2. Redis Debounce Check (HTTP Request) — calls Upstash SET NX EX 10 (replaces $json with Redis response)
 *   3. Is New Event? (IF) — gates on Redis result: OK=proceed, null=duplicate
 *   4. Restore Event (Code) — merges original event back from Build Debounce Key so downstream sees original payload
 *
 * Duplicates get a 200 response and stop. New events proceed to the existing flow.
 *
 * Usage:
 *   node patch-router-debounce.js             # apply changes
 *   node patch-router-debounce.js --dry-run   # preview without applying
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
const BACKUP_PATH = join(ROOT, 'server', 'notion-webhook-router-live.json');

// Strip surrounding quotes from env values (loadEnv doesn't strip them)
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
// API helpers
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
// Debounce node names (for idempotent cleanup)
// ---------------------------------------------------------------------------
const DEBOUNCE_NAMES = new Set([
  'Build Debounce Key',
  'Redis Debounce Check',
  'Is New Event?',
  'Restore Event',
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

// 2. Clean up any previous debounce patch (idempotent)
const beforeCount = router.nodes.length;
router.nodes = router.nodes.filter(n => !DEBOUNCE_NAMES.has(n.name));
if (beforeCount > router.nodes.length) {
  console.log(`  Cleaned up ${beforeCount - router.nodes.length} existing debounce node(s)`);
}
for (const name of DEBOUNCE_NAMES) delete router.connections[name];

// 3. Find anchor nodes
const skipDeletedNode = router.nodes.find(n => n.name === 'Skip Deleted Events');
const sortByTimestampNode = router.nodes.find(n => n.name === 'Sort by Timestamp');
if (!skipDeletedNode || !sortByTimestampNode) {
  console.error('Could not find "Skip Deleted Events" or "Sort by Timestamp" node');
  process.exit(1);
}

// Restore the direct connection from Skip Deleted Events → Sort by Timestamp
// (in case it was rewired by a previous run)
router.connections['Skip Deleted Events'] = {
  main: [[{ node: 'Sort by Timestamp', type: 'main', index: 0 }]],
};

console.log(`  Anchor: Skip Deleted Events at [${skipDeletedNode.position}]`);
console.log(`  Anchor: Sort by Timestamp at [${sortByTimestampNode.position}]`);

// 4. Calculate positions for new nodes
// Skip Deleted Events is at x=-432, Sort by Timestamp at x=-208 (gap=224px)
// We need 3 new nodes at 224px spacing, so shift Sort by Timestamp + downstream right by 672px
const skipX = skipDeletedNode.position[0];
const skipY = skipDeletedNode.position[1];
const SPACING = 224;
const SHIFT = SPACING * 4; // 896px

// Shift all nodes at or to the right of Sort by Timestamp
const shiftThreshold = sortByTimestampNode.position[0];
for (const node of router.nodes) {
  if (node.position[0] >= shiftThreshold) {
    node.position = [node.position[0] + SHIFT, node.position[1]];
  }
}
console.log(`  Shifted ${router.nodes.filter(n => n.position[0] >= shiftThreshold + SHIFT).length} nodes right by ${SHIFT}px`);

// New node positions (between Skip Deleted Events and shifted Sort by Timestamp)
const buildKeyPos = [skipX + SPACING, skipY];           // [-208, 624]
const redisCheckPos = [skipX + SPACING * 2, skipY];     // [16, 624]
const ifNewEventPos = [skipX + SPACING * 3, skipY];     // [240, 624]
const restoreEventPos = [skipX + SPACING * 4, skipY];   // [464, 624]

// 5. Create the three debounce nodes

// 5a. Build Debounce Key (Code node)
// Extracts entity ID and builds the Redis REST API request body
const buildKeyNode = {
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: [
      'const entityId = $json.body.data.id;',
      'return {',
      '  json: {',
      '    ...$json,',
      '    _debounceBody: JSON.stringify(["SET", `debounce:page:${entityId}`, "1", "EX", "10", "NX"]),',
      '  }',
      '};',
    ].join('\n'),
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: buildKeyPos,
  id: crypto.randomUUID(),
  name: 'Build Debounce Key',
};

// 5b. Redis Debounce Check (HTTP Request node)
// POST to Upstash REST API with SET NX EX command
const redisCheckNode = {
  parameters: {
    method: 'POST',
    url: UPSTASH_URL,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: `Bearer ${UPSTASH_TOKEN}` },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json._debounceBody }}',
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: redisCheckPos,
  id: crypto.randomUUID(),
  name: 'Redis Debounce Check',
};

// 5c. Is New Event? (IF node)
// Redis SET NX returns {"result": "OK"} for first event, {"result": null} for duplicate
const ifNewEventNode = {
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
          id: 'debounce-gate-check',
          leftValue: '={{ $json.result }}',
          rightValue: 'OK',
          operator: {
            type: 'string',
            operation: 'equals',
            name: 'filter.operator.equals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: ifNewEventPos,
  id: crypto.randomUUID(),
  name: 'Is New Event?',
};

// 5d. Restore Event (Code node)
// HTTP Request replaces $json with Redis response. This node restores the original
// event payload from Build Debounce Key so downstream nodes see the original data.
const restoreEventNode = {
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: [
      "const orig = $('Build Debounce Key').item.json;",
      'const { _debounceBody, ...event } = orig;',
      'return { json: event };',
    ].join('\n'),
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: restoreEventPos,
  id: crypto.randomUUID(),
  name: 'Restore Event',
};

router.nodes.push(buildKeyNode, redisCheckNode, ifNewEventNode, restoreEventNode);
console.log('  Added nodes: Build Debounce Key, Redis Debounce Check, Is New Event?, Restore Event');

// 6. Wire connections

// Skip Deleted Events → Build Debounce Key (replaces old → Sort by Timestamp)
router.connections['Skip Deleted Events'] = {
  main: [[{ node: 'Build Debounce Key', type: 'main', index: 0 }]],
};

// Build Debounce Key → Redis Debounce Check
router.connections['Build Debounce Key'] = {
  main: [[{ node: 'Redis Debounce Check', type: 'main', index: 0 }]],
};

// Redis Debounce Check → Is New Event?
router.connections['Redis Debounce Check'] = {
  main: [[{ node: 'Is New Event?', type: 'main', index: 0 }]],
};

// Is New Event? → true (output 0): Restore Event (merge original payload back)
//               → false (output 1): Success: Respond to Webhook (drop duplicate)
router.connections['Is New Event?'] = {
  main: [
    [{ node: 'Restore Event', type: 'main', index: 0 }],
    [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
  ],
};

// Restore Event → Sort by Timestamp (continue processing with original payload)
router.connections['Restore Event'] = {
  main: [[{ node: 'Sort by Timestamp', type: 'main', index: 0 }]],
};

console.log('  Wired: Skip Deleted Events → Build Debounce Key → Redis Debounce Check → Is New Event?');
console.log('  Wired: Is New Event? (true) → Restore Event → Sort by Timestamp');
console.log('  Wired: Is New Event? (false) → Success: Respond to Webhook\n');

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
console.log('\nDone. Verify in the n8n UI that the debounce gate appears between');
console.log('"Skip Deleted Events" and "Sort by Timestamp".');
