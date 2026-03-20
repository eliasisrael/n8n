/**
 * patch-router-layout.js
 *
 * Relayouts the Notion Webhook Router to comply with the canvas layout rules:
 *   1. Left-to-right flow (upstream nodes left of downstream)
 *   2. Output 0 branches above output 1
 *   3. Minimize arc crossings
 *
 * Changes:
 *   - Moves all nodes to new positions (3 horizontal bands: audit y=200, spine y=400, drop y=680, error y=880)
 *   - Closes the 672px gap between Restore Event (Maintenance) and Calculate Signature
 *   - Flips the If Maintenance? condition from `notEmpty` to `empty` and swaps its output wiring
 *     so output 0 = continue processing (on spine) and output 1 = drop (below spine)
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node patch-router-layout.js             # apply changes
 *   node patch-router-layout.js --dry-run   # preview without applying
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
// API helpers (same pattern as patch-router-qstash.js)
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
// New positions
// ---------------------------------------------------------------------------
const POSITIONS = {
  'Webhook':                        [-1104, 400],
  'Maintenance Check':              [-880, 400],
  'If Maintenance?':                [-656, 400],
  'Restore Event (Maintenance)':    [-432, 400],
  'Calculate Signature':            [-208, 400],
  'Trusted Payload?':               [16, 400],
  'Skip Deleted Events':            [240, 400],
  'Is Database Event?':             [464, 400],
  'Fetch Database':                 [688, 200],   // audit branch (above spine)
  'Build Redis Pipeline':           [688, 400],   // on spine
  'Execution Data':                 [912, 200],   // audit branch (above spine)
  'Redis Pipeline':                 [912, 400],   // on spine
  'Restore Event + Extract Results': [1136, 400],
  'Is Routable Event?':             [1360, 400],
  'Publish to QStash':              [1584, 400],
  'Success: Respond to Webhook':    [1808, 680],  // drop row (below spine)
  'Error: Respond to Webhook':      [1808, 880],  // error row (below drop)
  'Sticky Note':                    [128, 160],   // above Skip Deleted Events
};

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

// 2. Update positions
let updated = 0;
for (const node of router.nodes) {
  const newPos = POSITIONS[node.name];
  if (newPos) {
    const oldPos = [...node.position];
    node.position = newPos;
    if (oldPos[0] !== newPos[0] || oldPos[1] !== newPos[1]) {
      console.log(`  ${node.name}: [${oldPos}] → [${newPos}]`);
      updated++;
    } else {
      console.log(`  ${node.name}: [${oldPos}] (unchanged)`);
    }
  } else {
    console.warn(`  WARNING: No position defined for "${node.name}" — left at [${node.position}]`);
  }
}
console.log(`\n  Updated ${updated} node positions\n`);

// 3. Flip If Maintenance? condition: notEmpty → empty
//    This makes output 0 = "result is empty" (no maintenance, continue processing)
//    and output 1 = "result is not empty" (maintenance active, drop event)
const maintenanceNode = router.nodes.find(n => n.name === 'If Maintenance?');
if (!maintenanceNode) {
  console.error('Could not find "If Maintenance?" node');
  process.exit(1);
}

const cond = maintenanceNode.parameters.conditions.conditions[0];
if (cond.operator.operation === 'notEmpty') {
  cond.operator.operation = 'empty';
  delete cond.operator.name;  // clean up stale name field
  console.log('  Flipped If Maintenance? condition: notEmpty → empty');
} else if (cond.operator.operation === 'empty') {
  console.log('  If Maintenance? condition already set to empty (idempotent)');
} else {
  console.warn(`  WARNING: If Maintenance? has unexpected operation "${cond.operator.operation}" — skipping flip`);
}

// 4. Swap If Maintenance? output wiring
//    Before: out0 → Success: Respond, out1 → Restore Event (Maintenance)
//    After:  out0 → Restore Event (Maintenance), out1 → Success: Respond
const maintenanceConn = router.connections['If Maintenance?'];
if (maintenanceConn && maintenanceConn.main && maintenanceConn.main.length === 2) {
  const out0 = maintenanceConn.main[0];
  const out1 = maintenanceConn.main[1];

  // Verify current wiring before swapping
  const out0Target = out0?.[0]?.node;
  const out1Target = out1?.[0]?.node;

  if (out0Target === 'Restore Event (Maintenance)' && out1Target === 'Success: Respond to Webhook') {
    console.log('  If Maintenance? wiring already correct (out0=Restore, out1=Success) — idempotent');
  } else if (out0Target === 'Success: Respond to Webhook' && out1Target === 'Restore Event (Maintenance)') {
    maintenanceConn.main = [out1, out0];
    console.log('  Swapped If Maintenance? wiring: out0→Restore Event, out1→Success: Respond');
  } else {
    console.warn(`  WARNING: Unexpected If Maintenance? wiring (out0→${out0Target}, out1→${out1Target}) — skipping swap`);
  }
} else {
  console.warn('  WARNING: Could not find If Maintenance? connections — skipping swap');
}

console.log('');

// 5. Save backup
writeFileSync(BACKUP_PATH, JSON.stringify(router, null, 2));
console.log(`  Saved backup to ${BACKUP_PATH}`);

// 6. Push to server
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
console.log('\nDone. Layout changes applied:');
console.log('  - Main spine at y=400, audit branch at y=200');
console.log('  - Drop targets (Success: Respond) at y=680, errors at y=880');
console.log('  - If Maintenance? condition flipped (empty) so out0=continue, out1=drop');
console.log('  - 672px gap closed to 224px between Restore Event and Calculate Signature');
