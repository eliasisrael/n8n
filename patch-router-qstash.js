/**
 * patch-router-qstash.js
 *
 * Phase 3: Replace the router's debounce gate + Switch fan-out with a
 * combined Redis pipeline (debounce + topic lookup) and QStash publish.
 *
 * Idempotent — safe to re-run. Removes any previously-inserted QStash nodes
 * before re-adding them.
 *
 * Removes:
 *   - Phase 1 debounce nodes (Build Debounce Key, Redis Debounce Check, Is New Event?, Restore Event)
 *   - Sort by Timestamp, If Parent is DB, Notion (page-check), Execution Data
 *   - If Subscribed Database Updated, Load Referenced Page, Wrap Record, Merge
 *   - Route By Database (Switch, 11 outputs)
 *   - 9 Format nodes, 15 Execute Workflow nodes, No Format, No Sub-Flow
 *
 * Inserts 9 nodes after "Skip Deleted Events":
 *   1. Is Database Event? (IF) — discards non-database parent events
 *   2. Fetch Database (Notion) — fetches database metadata for name (parallel branch)
 *   3. Build Redis Pipeline (Code) — builds pipeline body for debounce SET + topic GET
 *   4. Redis Pipeline (HTTP Request) — POST /pipeline to Upstash (retryOnFail, error output)
 *   5. Restore Event + Extract Results (Code) — merges original event, extracts _isNew + _topicName
 *   6. Is Routable Event? (IF) — gates on _isNew === "OK" AND _topicName present
 *   7. Publish to QStash (HTTP Request) — POST /v2/publish/{topicName} with 10s delay (retryOnFail, error output)
 *   8. Error: Respond to Webhook (Respond to Webhook, 503) — explicit retry signal to Notion
 *   9. Execution Data — captures database name, topic, page ID, event type for QA/search
 *
 * Resilience:
 *   - Both HTTP nodes retry 3× with 2s backoff before giving up
 *   - Both HTTP nodes use onError: continueErrorOutput so failures route to
 *     an explicit 503 response instead of timing out silently
 *   - Notion sees the 503 and retries (debounce key expires in 10s, well before
 *     Notion's retry interval of ~minutes)
 *
 * Wiring:
 *   Skip Deleted Events → Is Database Event?
 *     → [true]  Build Redis Pipeline → Redis Pipeline
 *               + Fetch Database → Execution Data
 *       → [success] Restore + Extract → Is Routable?
 *         → [true]  Publish to QStash → [success] Success (200)
 *                                      → [error]   Error (503)
 *         → [false] Success (200)
 *       → [error] Error (503)
 *     → [false] Success (200)
 *
 * Usage:
 *   node patch-router-qstash.js             # apply changes
 *   node patch-router-qstash.js --dry-run   # preview without applying
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
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

function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

const UPSTASH_URL = stripQuotes(env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = stripQuotes(env.UPSTASH_REDIS_REST_TOKEN);
const QSTASH_TOKEN = stripQuotes(env.QSTASH_TOKEN);
const QSTASH_URL = stripQuotes(env.QSTASH_URL || 'https://qstash.upstash.io');

const dryRun = process.argv.includes('--dry-run');

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in .env');
  process.exit(1);
}
if (!QSTASH_TOKEN) {
  console.error('Missing QSTASH_TOKEN in .env');
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
// Nodes to remove
// ---------------------------------------------------------------------------

// Phase 1 debounce nodes
const DEBOUNCE_NAMES = new Set([
  'Build Debounce Key',
  'Redis Debounce Check',
  'Is New Event?',
  'Restore Event',
]);

// Downstream processing chain (everything after the debounce gate)
const DOWNSTREAM_NAMES = new Set([
  'Sort by Timestamp',
  'If Parent is DB',
  'Notion',                              // the page-existence check node
  'Execution Data',
  'If Subscribed Database Updated',
  'Load Referenced Page',
  'Wrap Record',
  'Merge',
  'Route By Database',
  // Format nodes
  'Format Appearance',
  'Format Contact',
  'Format Client',
  'Format Partner',
  'Format Download',
  'Format Testimonial',
  'Format Engagement',
  'Format Product',
  'Format Book Endorsement',
  // Execute Workflow nodes
  'Execute Appearances Workflow',
  'Execute Contacts Workflow',
  'Execute Clients Workflow',
  'Execute Partners Workflow',
  'Execute Downloads Workflow',
  'Execute Testimonials Workflow',
  'Execute Engagements Workflow',
  'Execute Workflow',                     // Products execute node
  'Store Book Endorsement',
  // CST/SET per-pipeline execute nodes
  'Execute Close Stale Task (Comms)',
  'Execute Close Stale Task (Sales)',
  'Execute Close Stale Task (Partner)',
  'Execute Stage Entry Tasks (Comms)',
  'Execute Stage Entry Tasks (Sales)',
  'Execute Stage Entry Tasks (Partner)',
  // Fallback
  'No Format',
  'No Sub-Flow',
]);

// QStash nodes (this script's own nodes — for idempotent re-runs)
const QSTASH_NAMES = new Set([
  'Is Database Event?',
  'Fetch Database',
  'Build Redis Pipeline',
  'Redis Pipeline',
  'Restore Event + Extract Results',
  'Is Routable Event?',
  'Publish to QStash',
  'Error: Respond to Webhook',
  'Execution Data',
]);

const ALL_REMOVE = new Set([...DEBOUNCE_NAMES, ...DOWNSTREAM_NAMES, ...QSTASH_NAMES]);

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

// 2. Remove old nodes
const beforeCount = router.nodes.length;
router.nodes = router.nodes.filter(n => !ALL_REMOVE.has(n.name));
const removedCount = beforeCount - router.nodes.length;
console.log(`  Removed ${removedCount} nodes (expected ~38)`);

// Remove connections for all removed nodes
for (const name of ALL_REMOVE) {
  delete router.connections[name];
}

// Also clean up any connections referencing removed nodes from remaining nodes
for (const [sourceName, conn] of Object.entries(router.connections)) {
  if (ALL_REMOVE.has(sourceName)) {
    delete router.connections[sourceName];
    continue;
  }
  if (conn.main) {
    for (let i = 0; i < conn.main.length; i++) {
      if (conn.main[i]) {
        conn.main[i] = conn.main[i].filter(link => !ALL_REMOVE.has(link.node));
      }
    }
  }
}

// 3. Find anchor nodes
const skipDeletedNode = router.nodes.find(n => n.name === 'Skip Deleted Events');
const successNode = router.nodes.find(n => n.name === 'Success: Respond to Webhook');
if (!skipDeletedNode) {
  console.error('Could not find "Skip Deleted Events" node');
  process.exit(1);
}
if (!successNode) {
  console.error('Could not find "Success: Respond to Webhook" node');
  process.exit(1);
}

console.log(`  Anchor: Skip Deleted Events at [${skipDeletedNode.position}]`);
console.log(`  Anchor: Success: Respond to Webhook at [${successNode.position}]`);

// 4. Calculate positions for new nodes
//
// Layout convention (from manual adjustment on server):
//   - Validation spine (Webhook → Skip Deleted): y=528, x spacing ~224
//   - Gate + pipeline prep: y=528–600, staggered down slightly for visual depth
//   - Decision/fan-out (Is Routable → Publish): y steps down 528→624→696
//   - Parallel branch (Execution Data): same x as Is Routable, y-192 above
//   - Terminal nodes (Success, Error): aligned at same x, y spread (192 / 816)
//
const isDbEventPos       = [-208, 528];
const fetchDbPos         = [16, 360];   // parallel branch above main flow
const buildPipelinePos   = [16, 600];
const redisPipelinePos   = [240, 600];
const restoreExtractPos  = [464, 528];
const isRoutablePos      = [688, 624];
const publishPos         = [912, 696];
const execDataPos        = [240, 360];
const errorRespondPos    = [1136, 816];

successNode.position = [1136, 192];

console.log(`  New node positions: Build=${buildPipelinePos}, Redis=${redisPipelinePos}, Restore=${restoreExtractPos}, IF=${isRoutablePos}, Publish=${publishPos}`);

// 5. Create new nodes

// 5a. Is Database Event? (IF node)
// Discards webhook events whose parent is not a database (e.g., child pages).
// Only database_id parents have adapters registered, so non-DB events are noise.
const isDbEventNode = {
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
          leftValue: '={{ $json.body.data.parent.type }}',
          rightValue: 'database',
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
  position: isDbEventPos,
  id: crypto.randomUUID(),
  name: 'Is Database Event?',
};

// 5a2. Fetch Database (Notion node — fetches database metadata for name)
// Runs in parallel with the main Redis pipeline path. The database name
// is captured in Execution Data for QA/search. Uses continueOnFail so a
// Notion API error doesn't block the main routing flow.
const fetchDbNode = {
  parameters: {
    resource: 'database',
    databaseId: {
      __rl: true,
      value: '={{ $json.body.data.parent.id }}',
      mode: 'id',
    },
  },
  type: 'n8n-nodes-base.notion',
  typeVersion: 2.2,
  position: fetchDbPos,
  id: crypto.randomUUID(),
  name: 'Fetch Database',
  credentials: {
    notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
  },
  continueOnFail: true,
};

// 5b. Build Redis Pipeline (Code node)
const buildPipelineNode = {
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: [
      'const entityId = $json.body.entity.id;',
      'const dbId = $json.body.data.parent.id;',
      '',
      'return {',
      '  json: {',
      '    ...$json,',
      '    _pipelineBody: [',
      '      ["SET", `debounce:page:${entityId}`, "1", "EX", "10", "NX"],',
      '      ["GET", `dbtopic:${dbId}`]',
      '    ],',
      '  }',
      '};',
    ].join('\n'),
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: buildPipelinePos,
  id: crypto.randomUUID(),
  name: 'Build Redis Pipeline',
};

// 5b. Redis Pipeline (HTTP Request node)
// retryOnFail: 3 attempts with 2s backoff for transient Upstash errors
// onError: continueErrorOutput routes failures to explicit 503 response
const redisPipelineNode = {
  parameters: {
    method: 'POST',
    url: `${UPSTASH_URL}/pipeline`,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: `Bearer ${UPSTASH_TOKEN}` },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json._pipelineBody) }}',
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: redisPipelinePos,
  id: crypto.randomUUID(),
  name: 'Redis Pipeline',
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 2000,
  onError: 'continueErrorOutput',
};

// 5c. Restore Event + Extract Results (Code node)
// n8n's HTTP Request splits the Upstash pipeline JSON array into separate
// items, so we use runOnceForAllItems + $input.all() to read both results.
const restoreExtractNode = {
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: [
      "const orig = $('Build Redis Pipeline').first().json;",
      'const { _pipelineBody, ...event } = orig;',
      '',
      '// Upstash pipeline returns [{result: "OK"}, {result: "topic-name"}]',
      '// n8n splits the array into separate items',
      'const items = $input.all();',
      'const isNew = items[0]?.json?.result ?? null;       // "OK" or null',
      'const topicName = items[1]?.json?.result ?? null;   // topic name or null',
      '',
      'return [{',
      '  json: {',
      '    ...event,',
      '    _isNew: isNew,',
      '    _topicName: topicName,',
      '  }',
      '}];',
    ].join('\n'),
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: restoreExtractPos,
  id: crypto.randomUUID(),
  name: 'Restore Event + Extract Results',
};

// 5d. Is Routable Event? (IF node)
// Checks: _isNew === "OK" AND _topicName is not empty
const isRoutableNode = {
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
          leftValue: '={{ $json._isNew }}',
          rightValue: 'OK',
          operator: {
            type: 'string',
            operation: 'equals',
            name: 'filter.operator.equals',
          },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json._topicName }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            name: 'filter.operator.notEmpty',
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
  position: isRoutablePos,
  id: crypto.randomUUID(),
  name: 'Is Routable Event?',
};

// 5e. Publish to QStash (HTTP Request node)
// retryOnFail: 3 attempts with 2s backoff for transient QStash errors
// onError: continueErrorOutput routes failures to explicit 503 response
const publishNode = {
  parameters: {
    method: 'POST',
    url: `=${QSTASH_URL}/v2/publish/{{ $json._topicName }}`,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: `Bearer ${QSTASH_TOKEN}` },
        { name: 'Upstash-Delay', value: '10s' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: publishPos,
  id: crypto.randomUUID(),
  name: 'Publish to QStash',
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 2000,
  onError: 'continueErrorOutput',
};

// 5f. Error: Respond to Webhook (503)
// Explicit error response so Notion gets a fast retry signal instead of timing out
const errorRespondNode = {
  parameters: {
    respondWith: 'noData',
    options: {
      responseCode: 503,
    },
  },
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position: errorRespondPos,
  id: crypto.randomUUID(),
  name: 'Error: Respond to Webhook',
};

// Execution Data (tags execution for search/QA)
// Wired from Fetch Database — receives the Notion database object as $json.
// Also references Restore Event for Redis-derived topic name. This allows
// verification that Redis routing matches the actual database identity.
const execDataNode = {
  parameters: {
    dataToSave: {
      values: [
        {
          key: 'database',
          value: '={{ $json.name }}',
        },
        {
          key: 'databaseId',
          value: '={{ $json.id }}',
        },
        {
          key: 'url',
          value: '={{ $json.url }}',
        },
      ],
    },
  },
  type: 'n8n-nodes-base.executionData',
  typeVersion: 1.1,
  position: execDataPos,
  id: crypto.randomUUID(),
  name: 'Execution Data',
};

router.nodes.push(isDbEventNode, fetchDbNode, buildPipelineNode, redisPipelineNode, restoreExtractNode, isRoutableNode, publishNode, errorRespondNode, execDataNode);
console.log('  Added 9 nodes: Is Database Event?, Fetch Database, Build Redis Pipeline, Redis Pipeline, Restore Event + Extract Results, Is Routable Event?, Publish to QStash, Error: Respond to Webhook, Execution Data');

// 6. Wire connections

// Skip Deleted Events → Is Database Event?
router.connections['Skip Deleted Events'] = {
  main: [[{ node: 'Is Database Event?', type: 'main', index: 0 }]],
};

// Is Database Event? → true (output 0): Build Redis Pipeline + Fetch Database (parallel)
//                    → false (output 1): Success: Respond to Webhook (drop non-DB events)
router.connections['Is Database Event?'] = {
  main: [
    [
      { node: 'Build Redis Pipeline', type: 'main', index: 0 },
      { node: 'Fetch Database', type: 'main', index: 0 },
    ],
    [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
  ],
};

// Fetch Database → Execution Data
router.connections['Fetch Database'] = {
  main: [[{ node: 'Execution Data', type: 'main', index: 0 }]],
};

// Build Redis Pipeline → Redis Pipeline
router.connections['Build Redis Pipeline'] = {
  main: [[{ node: 'Redis Pipeline', type: 'main', index: 0 }]],
};

// Redis Pipeline → [success] Restore Event + Extract Results
//                → [error]   Error: Respond to Webhook (503)
router.connections['Redis Pipeline'] = {
  main: [
    [{ node: 'Restore Event + Extract Results', type: 'main', index: 0 }],
    [{ node: 'Error: Respond to Webhook', type: 'main', index: 0 }],
  ],
};

// Restore Event + Extract Results → Is Routable Event?
router.connections['Restore Event + Extract Results'] = {
  main: [[{ node: 'Is Routable Event?', type: 'main', index: 0 }]],
};

// Is Routable Event? → true (output 0): Publish to QStash
//                    → false (output 1): Success: Respond to Webhook (drop)
router.connections['Is Routable Event?'] = {
  main: [
    [{ node: 'Publish to QStash', type: 'main', index: 0 }],
    [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
  ],
};

// Publish to QStash → [success] Success: Respond to Webhook (200)
//                   → [error]   Error: Respond to Webhook (503)
router.connections['Publish to QStash'] = {
  main: [
    [{ node: 'Success: Respond to Webhook', type: 'main', index: 0 }],
    [{ node: 'Error: Respond to Webhook', type: 'main', index: 0 }],
  ],
};

console.log('  Wired: Skip Deleted Events → Is Database Event?');
console.log('    → [true]  Build Redis Pipeline → Redis Pipeline');
console.log('              + Fetch Database → Execution Data');
console.log('      → [success] Restore + Extract → Is Routable Event?');
console.log('        → [true]  Publish to QStash → [success] Success (200)');
console.log('                                    → [error]   Error (503)');
console.log('        → [false] Success (200)');
console.log('      → [error] Error (503)');
console.log('    → [false] Success (200, drop non-DB event)\n');

// 7. Summary
console.log(`  Final node count: ${router.nodes.length} (was ${beforeCount})`);
console.log(`  Remaining nodes: ${router.nodes.map(n => n.name).join(', ')}\n`);

// 8. Save backup
writeFileSync(BACKUP_PATH, JSON.stringify(router, null, 2));
console.log(`  Saved backup to ${BACKUP_PATH}`);

// 9. Push to server
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
console.log('\nDone. The router now:');
console.log('  1. Validates signature + skips deleted events (unchanged)');
console.log('  2. Debounces via Redis SET NX + looks up QStash topic in single pipeline call');
console.log('  3. Publishes to QStash with 10s delay for adapter workflows to pick up');
console.log('\nNext: activate adapter workflows, then test end-to-end.');
