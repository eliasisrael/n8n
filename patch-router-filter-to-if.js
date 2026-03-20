/**
 * patch-router-filter-to-if.js
 *
 * Converts two Filter nodes to IF nodes so that rejected items get an HTTP
 * response instead of silently dropping (causing webhook timeouts).
 *
 * Problem:
 *   - "Trusted Payload?" (Filter) drops untrusted payloads → no Respond node fires → timeout
 *   - "Skip Deleted Events" (Filter) drops .deleted events → no Respond node fires → timeout
 *   Notion sends one event per webhook call, so a filter drop = zero items = dead end.
 *
 * Fix:
 *   - Change both from n8n-nodes-base.filter to n8n-nodes-base.if (same conditions structure)
 *   - Wire output 1 (false) of each to "Success: Respond to Webhook" (200 OK)
 *   - Output 0 (true) continues to the next node as before
 *
 * Idempotent — safe to re-run. Detects if nodes are already IF type.
 *
 * Usage:
 *   node patch-router-filter-to-if.js             # apply changes
 *   node patch-router-filter-to-if.js --dry-run   # preview without applying
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

const dryRun = process.argv.includes('--dry-run');

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const ALLOWED_NODE_KEYS = new Set([
  'id', 'name', 'type', 'typeVersion', 'position', 'parameters',
  'credentials', 'disabled', 'onError', 'retryOnFail', 'maxTries',
  'waitBetweenTries', 'executeOnce', 'continueOnFail', 'alwaysOutputData',
  'notesInFlow', 'notes', 'webhookId',
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
// Nodes to convert
// ---------------------------------------------------------------------------
const NODES_TO_CONVERT = [
  'Trusted Payload?',
  'Skip Deleted Events',
];

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

// 2. Convert Filter → IF for each target node
for (const nodeName of NODES_TO_CONVERT) {
  const node = router.nodes.find(n => n.name === nodeName);
  if (!node) {
    console.error(`  Could not find "${nodeName}" node`);
    process.exit(1);
  }

  if (node.type === 'n8n-nodes-base.if') {
    console.log(`  ${nodeName}: already an IF node (idempotent)`);
  } else if (node.type === 'n8n-nodes-base.filter') {
    node.type = 'n8n-nodes-base.if';
    node.typeVersion = 2.2;
    console.log(`  ${nodeName}: converted filter → if (typeVersion 2.2)`);
  } else {
    console.warn(`  WARNING: ${nodeName} has unexpected type "${node.type}" — skipping`);
    continue;
  }

  // 3. Wire output 1 (false) → Success: Respond to Webhook
  const conn = router.connections[nodeName];
  if (!conn || !conn.main) {
    console.error(`  No connections found for "${nodeName}"`);
    process.exit(1);
  }

  // Filter nodes have only main[0] (pass). IF nodes have main[0] (true) and main[1] (false).
  // Ensure output 0 (true) keeps existing wiring, and add output 1 (false) → Success: Respond.
  if (conn.main.length === 1) {
    // Was a Filter — only had one output. Add the false branch.
    conn.main.push([
      { node: 'Success: Respond to Webhook', type: 'main', index: 0 },
    ]);
    console.log(`  ${nodeName}: wired output 1 (false) → Success: Respond to Webhook`);
  } else if (conn.main.length >= 2) {
    // Already has two outputs (idempotent re-run or was already IF)
    const falseTarget = conn.main[1]?.[0]?.node;
    if (falseTarget === 'Success: Respond to Webhook') {
      console.log(`  ${nodeName}: output 1 already wired to Success: Respond (idempotent)`);
    } else {
      console.warn(`  WARNING: ${nodeName} output 1 wired to "${falseTarget}" — replacing with Success: Respond`);
      conn.main[1] = [
        { node: 'Success: Respond to Webhook', type: 'main', index: 0 },
      ];
    }
  }
}

console.log('');

// 4. Save backup
writeFileSync(BACKUP_PATH, JSON.stringify(router, null, 2));
console.log(`  Saved backup to ${BACKUP_PATH}`);

// 5. Push to server
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
console.log('\nDone. Both filter nodes converted to IF nodes:');
console.log('  - Trusted Payload?: untrusted payloads now get 200 response (instead of timeout)');
console.log('  - Skip Deleted Events: deleted events now get 200 response (instead of timeout)');
