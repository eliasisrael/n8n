/**
 * patch-router-secret.js
 *
 * Replace the hardcoded Notion webhook verification secret in the
 * "Calculate Signature" Code node with the value from the
 * NOTION_WEBHOOK_SECRET environment variable.
 *
 * This is idempotent — it performs a regex replacement on the
 * `const verificationToken = "..."` line in the jsCode, so it works
 * regardless of what secret is currently embedded.
 *
 * Usage:
 *   op run --env-file=.env.tpl -- node patch-router-secret.js             # apply
 *   op run --env-file=.env.tpl -- node patch-router-secret.js --dry-run   # preview
 */

import loadEnv from './lib/load-env.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = loadEnv({ required: true });
const BASE_URL = env.N8N_BASE_URL;
const API_KEY = env.N8N_API_KEY;
const NOTION_WEBHOOK_SECRET = env.NOTION_WEBHOOK_SECRET;
const ROUTER_ID = '6kSboH0MtIOedeja';

const dryRun = process.argv.includes('--dry-run');

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}
if (!NOTION_WEBHOOK_SECRET) {
  console.error('Missing NOTION_WEBHOOK_SECRET in .env');
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

// 2. Find "Calculate Signature" node
const calcSigNode = router.nodes.find(n => n.name === 'Calculate Signature');
if (!calcSigNode) {
  console.error('Could not find "Calculate Signature" node');
  process.exit(1);
}

// 3. Replace the hardcoded secret in jsCode
const oldCode = calcSigNode.parameters.jsCode;
const pattern = /const verificationToken = "[^"]*"/;

if (!pattern.test(oldCode)) {
  console.error('Could not find `const verificationToken = "..."` in Calculate Signature jsCode');
  process.exit(1);
}

const newCode = oldCode.replace(pattern, `const verificationToken = "${NOTION_WEBHOOK_SECRET}"`);

if (oldCode === newCode) {
  console.log('  Secret already matches — nothing to do.');
  process.exit(0);
}

calcSigNode.parameters.jsCode = newCode;
console.log('  Replaced verificationToken in "Calculate Signature" jsCode');

// 4. Push to server
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
console.log('\nDone. The webhook verification secret has been updated in "Calculate Signature".');
