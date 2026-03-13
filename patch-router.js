/**
 * patch-router.js
 *
 * One-off script to wire pipeline sub-workflows into the Notion Webhook Router.
 *
 * Changes:
 *   1. Add Switch outputs for Sales Pipeline and Partner Pipeline
 *   2. Add 3 Execute Close Stale Task nodes (Sales, Partner, Comms)
 *   3. Add 3 Execute Stage Entry Tasks nodes (Sales, Partner, Comms)
 *   4. Fan-out Appearance output to also trigger Close Stale Task + Stage Entry Tasks (Comms)
 *   5. Fan-out Sales/Partner outputs to both Close Stale Task + Stage Entry Tasks
 *   6. Connect all Execute nodes to Success: Respond to Webhook
 *
 * Usage:
 *   node patch-router.js             # apply changes
 *   node patch-router.js --dry-run   # preview without applying
 */

import { readFileSync, writeFileSync } from 'fs';
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
const CLOSE_STALE_TASK_ID = 'EIkTeuoWsQ6fAgNO';
const STAGE_ENTRY_TASKS_ID = 'MXmnk2bPGxMn8ROL';
const BACKUP_PATH = join(ROOT, 'server', 'notion-webhook-router-live.json');

const dryRun = process.argv.includes('--dry-run');

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers (from push-workflows.js)
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

// 2. Clean up any previous patch artifacts (make idempotent)
const patchedNames = new Set([
  'Execute Close Stale Task (Comms)',
  'Execute Close Stale Task (Sales)',
  'Execute Close Stale Task (Partner)',
  'Execute Stage Entry Tasks (Comms)',
  'Execute Stage Entry Tasks (Sales)',
  'Execute Stage Entry Tasks (Partner)',
]);
const removedCount = router.nodes.length;
router.nodes = router.nodes.filter(n => !patchedNames.has(n.name));
if (removedCount > router.nodes.length) {
  console.log(`  Cleaned up ${removedCount - router.nodes.length} existing patched node(s)`);
}
// Remove their connection entries
for (const name of patchedNames) delete router.connections[name];

// 3. Find the Switch node
const switchNode = router.nodes.find(n => n.name === 'Route By Database');
if (!switchNode) {
  console.error('Could not find "Route By Database" Switch node');
  process.exit(1);
}

// Remove any existing Sales Pipeline / Partner Pipeline Switch rules
switchNode.parameters.rules.values = switchNode.parameters.rules.values.filter(
  r => r.outputKey !== 'Sales Pipeline' && r.outputKey !== 'Partner Pipeline'
);

// Remove CST fan-out from Appearance output and rebuild connections cleanly
const routeConnsRaw = router.connections['Route By Database']?.main;
if (routeConnsRaw) {
  // Strip any patched targets from all outputs
  for (let i = 0; i < routeConnsRaw.length; i++) {
    if (Array.isArray(routeConnsRaw[i])) {
      routeConnsRaw[i] = routeConnsRaw[i].filter(c => !patchedNames.has(c.node));
    }
  }
  // Trim empty trailing outputs (leftover from removed rules)
  while (routeConnsRaw.length > 0 && (!routeConnsRaw[routeConnsRaw.length - 1] || routeConnsRaw[routeConnsRaw.length - 1].length === 0)) {
    routeConnsRaw.pop();
  }
  // Also pop if the last entry is the fallback — we'll re-add it at the right index
}

console.log('  Cleaned Switch rules and connections');

// 4. Add two new Switch rules for Sales Pipeline and Partner Pipeline
const newRules = [
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'sales-pipeline-rule',
          leftValue: '={{ $json.body.data.parent.id }}',
          rightValue: '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f',
          operator: {
            type: 'string',
            operation: 'equals',
            name: 'filter.operator.equals',
          },
        },
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey: 'Sales Pipeline',
  },
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'partner-pipeline-rule',
          leftValue: '={{ $json.body.data.parent.id }}',
          rightValue: '457cfa4c-123b-4718-a7d3-c8bf7ea4a27e',
          operator: {
            type: 'string',
            operation: 'equals',
            name: 'filter.operator.equals',
          },
        },
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey: 'Partner Pipeline',
  },
];

switchNode.parameters.rules.values.push(...newRules);
console.log('  Added Switch rules: Sales Pipeline, Partner Pipeline');

// 4. Create three Execute Close Stale Task nodes
function makeCloseStaleNode(name, position) {
  return {
    parameters: {
      workflowId: {
        __rl: true,
        value: CLOSE_STALE_TASK_ID,
        mode: 'list',
        cachedResultName: 'Close Stale Task',
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {},
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position,
    id: crypto.randomUUID(),
    name,
  };
}

// Comms shares the Appearance output — place it near the Appearance row (y=-720)
const commsCSTNode = makeCloseStaleNode('Execute Close Stale Task (Comms)', [1584, -912]);
// Sales and Partner get their own Switch outputs — place below the fallback row
const salesCSTNode = makeCloseStaleNode('Execute Close Stale Task (Sales)', [1584, 1248]);
const partnerCSTNode = makeCloseStaleNode('Execute Close Stale Task (Partner)', [1584, 1440]);

router.nodes.push(commsCSTNode, salesCSTNode, partnerCSTNode);
console.log('  Added nodes: Execute Close Stale Task (Comms, Sales, Partner)');

// 4b. Create three Execute Stage Entry Tasks nodes
function makeStageEntryNode(name, position) {
  return {
    parameters: {
      workflowId: {
        __rl: true,
        value: STAGE_ENTRY_TASKS_ID,
        mode: 'list',
        cachedResultName: 'Stage Entry Tasks',
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {},
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position,
    id: crypto.randomUUID(),
    name,
  };
}

// Position 224px to the right of the corresponding CST nodes, same y-coordinate
const commsSETNode = makeStageEntryNode('Execute Stage Entry Tasks (Comms)', [1808, -912]);
const salesSETNode = makeStageEntryNode('Execute Stage Entry Tasks (Sales)', [1808, 1248]);
const partnerSETNode = makeStageEntryNode('Execute Stage Entry Tasks (Partner)', [1808, 1440]);

router.nodes.push(commsSETNode, salesSETNode, partnerSETNode);
console.log('  Added nodes: Execute Stage Entry Tasks (Comms, Sales, Partner)');

// 5. Wire connections

// 5a. Fan-out Appearance output (index 0) to also hit Close Stale Task (Comms)
const routeConns = router.connections['Route By Database']?.main;
if (!routeConns) {
  console.error('Could not find Route By Database connections');
  process.exit(1);
}

// Appearance is output index 0 — add targets for both pipeline sub-workflows
routeConns[0].push(
  { node: commsCSTNode.name, type: 'main', index: 0 },
  { node: commsSETNode.name, type: 'main', index: 0 },
);
console.log('  Fan-out: Appearance output → Close Stale Task (Comms) + Stage Entry Tasks (Comms)');

// 5b. The new rules are the last two in the array.
// Sales Pipeline = rules.length - 2, Partner Pipeline = rules.length - 1
const totalRules = switchNode.parameters.rules.values.length;
const salesOutputIndex = totalRules - 2;
const partnerOutputIndex = totalRules - 1;
const fallbackIndex = totalRules; // "extra" output is always after all rules

// Ensure routeConns array is long enough for all outputs + fallback
while (routeConns.length <= fallbackIndex) routeConns.push([]);

// Move fallback connections to the correct index if needed
// The fallback should be at fallbackIndex. Find any "No Format" target and ensure it's there.
for (let i = 0; i < routeConns.length; i++) {
  if (i === fallbackIndex) continue;
  const hasNoFormat = Array.isArray(routeConns[i]) &&
    routeConns[i].some(c => c.node === 'No Format');
  if (hasNoFormat) {
    routeConns[fallbackIndex] = routeConns[i];
    routeConns[i] = [];
    break;
  }
}

routeConns[salesOutputIndex] = [
  { node: salesCSTNode.name, type: 'main', index: 0 },
  { node: salesSETNode.name, type: 'main', index: 0 },
];
routeConns[partnerOutputIndex] = [
  { node: partnerCSTNode.name, type: 'main', index: 0 },
  { node: partnerSETNode.name, type: 'main', index: 0 },
];
console.log(`  Wired: Sales Pipeline (output ${salesOutputIndex}) → Close Stale Task + Stage Entry Tasks (Sales)`);
console.log(`  Wired: Partner Pipeline (output ${partnerOutputIndex}) → Close Stale Task + Stage Entry Tasks (Partner)`);

// 5c. All six pipeline nodes → Success: Respond to Webhook
const allPipelineNodes = [
  commsCSTNode, salesCSTNode, partnerCSTNode,
  commsSETNode, salesSETNode, partnerSETNode,
];
for (const node of allPipelineNodes) {
  router.connections[node.name] = {
    main: [
      [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
    ],
  };
}
console.log('  Wired: All 6 pipeline nodes → Success: Respond to Webhook\n');

// 6. Save backup
writeFileSync(BACKUP_PATH, JSON.stringify(router, null, 2));
console.log(`  Saved backup to ${BACKUP_PATH}`);

// 7. Push to server
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
console.log(`  ✓ Router updated successfully (${result.nodes.length} nodes)`);
console.log('\nDone. Verify in the n8n UI that the new routes and nodes appear correctly.');
