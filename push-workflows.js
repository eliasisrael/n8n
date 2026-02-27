/**
 * push-workflows.js
 *
 * Pushes built workflows from output/ to the n8n server.
 * Matches by workflow name: updates if it already exists, creates if new.
 *
 * Usage:
 *   node push-workflows.js                        # push all built workflows
 *   node push-workflows.js --workflow my-flow      # push one (omit .json)
 *   node push-workflows.js --dry-run               # show what would happen
 *
 * Requires .env with N8N_BASE_URL and N8N_API_KEY.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = new URL('.', import.meta.url).pathname;
const ENV_PATH = join(ROOT, '.env');
const OUTPUT_DIR = join(ROOT, 'output');

function loadEnv() {
  const text = readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv();
const BASE_URL = env.N8N_BASE_URL;
const API_KEY = env.N8N_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch ALL workflows from the server (handles pagination). */
async function fetchAllWorkflows() {
  const all = [];
  let cursor = null;

  do {
    const url = new URL('/api/v1/workflows', BASE_URL);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': API_KEY },
    });
    if (!res.ok) throw new Error(`List workflows failed: ${res.status}`);

    const page = await res.json();
    all.push(...page.data);
    cursor = page.nextCursor || null;
  } while (cursor);

  return all;
}

/**
 * Strip a node to only the fields the n8n API accepts.
 * The API is stricter than the JSON import format and rejects
 * unknown top-level properties on nodes.
 */
// Fields the n8n API accepts on node objects (discovered empirically).
// Notably, node-level `settings` is REJECTED by the API even though it
// appears in GET responses and the JSON import format.
const ALLOWED_NODE_KEYS = new Set([
  'id', 'name', 'type', 'typeVersion', 'position', 'parameters',
  'credentials', 'disabled', 'onError', 'retryOnFail', 'executeOnce',
  'continueOnFail', 'alwaysOutputData', 'notesInFlow', 'notes', 'webhookId',
]);

function cleanNode(node) {
  const clean = {};
  for (const [key, value] of Object.entries(node)) {
    if (ALLOWED_NODE_KEYS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Strip a workflow JSON down to only the fields the n8n API accepts.
 * The PUT and POST endpoints reject extra properties like `active`,
 * `staticData`, `meta`, `pinData`, `tags`, etc.
 */
function toApiBody(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes.map(cleanNode),
    connections: wf.connections,
    settings: wf.settings,
  };
}

/** Create a new workflow on the server. */
async function createWorkflow(wf) {
  const res = await fetch(new URL('/api/v1/workflows', BASE_URL), {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toApiBody(wf)),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create failed (${res.status}): ${body}`);
  }
  return res.json();
}

/** Update an existing workflow on the server. */
async function updateWorkflow(id, wf) {
  const res = await fetch(new URL(`/api/v1/workflows/${id}`, BASE_URL), {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toApiBody(wf)),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Update failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const workflowFlag = args.indexOf('--workflow');
const targetName = workflowFlag >= 0 ? args[workflowFlag + 1] : null;

// Collect output files to push
if (!existsSync(OUTPUT_DIR)) {
  console.error('No output/ directory. Run `node build.js` first.');
  process.exit(1);
}

let files = readdirSync(OUTPUT_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('_'));

if (targetName) {
  const target = targetName.replace(/\.json$/, '') + '.json';
  files = files.filter(f => f === target);
  if (files.length === 0) {
    console.error(`Workflow "${targetName}" not found in output/. Built files:`);
    readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json')).forEach(f => console.error(`  ${f}`));
    process.exit(1);
  }
}

console.log(`Fetching existing workflows from ${BASE_URL}...`);
const serverWorkflows = await fetchAllWorkflows();

// Build a map of name → server workflow (for matching)
const serverByName = new Map();
for (const sw of serverWorkflows) {
  // If there are duplicates, keep the most recently updated one
  const existing = serverByName.get(sw.name);
  if (!existing || sw.updatedAt > existing.updatedAt) {
    serverByName.set(sw.name, sw);
  }
}

console.log(`Found ${serverWorkflows.length} workflow(s) on server.\n`);

let created = 0;
let updated = 0;
let errors = 0;

for (const file of files) {
  const wf = JSON.parse(readFileSync(join(OUTPUT_DIR, file), 'utf8'));
  const existing = serverByName.get(wf.name);

  if (existing) {
    const action = `update ${existing.id}`;
    if (dryRun) {
      console.log(`  [dry-run] ${file} → ${action} ("${wf.name}")`);
      updated++;
      continue;
    }

    try {
      const result = await updateWorkflow(existing.id, wf);
      console.log(`  ${file} → updated ${result.id} ("${wf.name}")`);
      updated++;
    } catch (err) {
      console.error(`  ${file} → ERROR: ${err.message}`);
      errors++;
    }
  } else {
    if (dryRun) {
      console.log(`  [dry-run] ${file} → create ("${wf.name}")`);
      created++;
      continue;
    }

    try {
      const result = await createWorkflow(wf);
      console.log(`  ${file} → created ${result.id} ("${wf.name}")`);
      created++;
    } catch (err) {
      console.error(`  ${file} → ERROR: ${err.message}`);
      errors++;
    }
  }
}

console.log(`\nDone. ${created} created, ${updated} updated, ${errors} error(s).`);
if (dryRun) console.log('(dry run — no changes made)');
if (errors > 0) process.exit(1);
