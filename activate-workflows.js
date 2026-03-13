/**
 * activate-workflows.js
 *
 * Activates workflows on the n8n server.
 *
 * Usage:
 *   node activate-workflows.js                         # activate all adapter workflows
 *   node activate-workflows.js --workflow my-flow       # activate one by name (omit .json)
 *   node activate-workflows.js --all                    # activate ALL built workflows
 *   node activate-workflows.js --dry-run                # show what would happen
 *
 * Requires .env with N8N_BASE_URL and N8N_API_KEY.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import loadEnv from './lib/load-env.js';

const ROOT = new URL('.', import.meta.url).pathname;
const OUTPUT_DIR = join(ROOT, 'output');

const env = loadEnv({ required: true });
const BASE_URL = env.N8N_BASE_URL;
const API_KEY = env.N8N_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const workflowFlag = args.indexOf('--workflow');
const targetName = workflowFlag >= 0 ? args[workflowFlag + 1] : null;

// Determine which workflow names to activate
let targetNames;
if (targetName) {
  // Single workflow
  const file = join(OUTPUT_DIR, targetName.replace(/\.json$/, '') + '.json');
  if (!existsSync(file)) {
    console.error(`Workflow "${targetName}" not found in output/.`);
    process.exit(1);
  }
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  targetNames = [wf.name];
} else if (all) {
  // All built workflows
  targetNames = readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => JSON.parse(readFileSync(join(OUTPUT_DIR, f), 'utf8')).name);
} else {
  // Default: only adapter workflows
  targetNames = readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('adapter-') && f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(OUTPUT_DIR, f), 'utf8')).name);
}

// Fetch all workflows from the server
async function fetchAllWorkflows() {
  const all = [];
  let cursor = null;
  do {
    const url = new URL('/api/v1/workflows', BASE_URL);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { 'X-N8N-API-KEY': API_KEY } });
    if (!res.ok) throw new Error(`List workflows failed: ${res.status}`);
    const page = await res.json();
    all.push(...page.data);
    cursor = page.nextCursor || null;
  } while (cursor);
  return all;
}

console.log(`Fetching workflows from ${BASE_URL}...`);
const serverWorkflows = await fetchAllWorkflows();
const serverByName = new Map(serverWorkflows.map(w => [w.name, w]));

let activated = 0;
let skipped = 0;
let errors = 0;

for (const name of targetNames) {
  const sw = serverByName.get(name);
  if (!sw) {
    console.error(`  "${name}" — not found on server`);
    errors++;
    continue;
  }
  if (sw.active) {
    console.log(`  "${name}" — already active`);
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`  [dry-run] "${name}" (${sw.id}) — would activate`);
    activated++;
    continue;
  }
  try {
    const res = await fetch(new URL(`/api/v1/workflows/${sw.id}/activate`, BASE_URL), {
      method: 'POST',
      headers: { 'X-N8N-API-KEY': API_KEY },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }
    console.log(`  "${name}" (${sw.id}) — activated`);
    activated++;
  } catch (err) {
    console.error(`  "${name}" — ERROR: ${err.message}`);
    errors++;
  }
}

console.log(`\nDone. ${activated} activated, ${skipped} already active, ${errors} error(s).`);
if (dryRun) console.log('(dry run — no changes made)');
if (errors > 0) process.exit(1);
