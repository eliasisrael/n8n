/**
 * pull-workflows.js
 *
 * Downloads all workflows from the n8n server and saves them to server/.
 * Skips workflows that haven't changed since the last pull (by updatedAt).
 *
 * Usage:
 *   node pull-workflows.js              # pull all workflows
 *   node pull-workflows.js --force      # re-download even if unchanged
 *   node pull-workflows.js --list       # list server workflows without downloading
 *
 * Requires .env with N8N_BASE_URL and N8N_API_KEY.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import loadEnv from './lib/load-env.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = new URL('.', import.meta.url).pathname;
const SERVER_DIR = join(ROOT, 'server');
const MANIFEST_PATH = join(SERVER_DIR, '.manifest.json');

const env = loadEnv({ required: true });
const BASE_URL = env.N8N_BASE_URL;
const API_KEY = env.N8N_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing N8N_BASE_URL or N8N_API_KEY in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Kebab-case a workflow name for use as a filename. */
function toFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Fetch a page of workflows from the n8n API. */
async function fetchWorkflows(cursor) {
  const url = new URL('/api/v1/workflows', BASE_URL);
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url, {
    headers: { 'X-N8N-API-KEY': API_KEY },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`n8n API ${res.status}: ${body}`);
  }

  return res.json();
}

/** Fetch ALL workflows, handling pagination. */
async function fetchAllWorkflows() {
  const all = [];
  let cursor = null;

  do {
    const page = await fetchWorkflows(cursor);
    all.push(...page.data);
    cursor = page.nextCursor || null;
  } while (cursor);

  return all;
}

/** Load the manifest (id → { filename, updatedAt }) or return empty. */
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Save the manifest. */
function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const force = args.includes('--force');
const listOnly = args.includes('--list');

console.log(`Fetching workflows from ${BASE_URL}...`);
const workflows = await fetchAllWorkflows();
console.log(`Found ${workflows.length} workflow(s) on the server.\n`);

if (listOnly) {
  const maxName = Math.max(...workflows.map(w => w.name.length));
  for (const w of workflows) {
    const status = w.active ? 'active' : 'inactive';
    console.log(`  ${w.id}  ${w.name.padEnd(maxName)}  [${status}]`);
  }
  process.exit(0);
}

// Ensure server/ exists
mkdirSync(SERVER_DIR, { recursive: true });

// Detect duplicate workflow names and append ID to disambiguate
const nameCounts = {};
for (const wf of workflows) {
  const base = toFilename(wf.name);
  nameCounts[base] = (nameCounts[base] || 0) + 1;
}

const manifest = loadManifest();
let downloaded = 0;
let skipped = 0;
const newManifest = {};

for (const wf of workflows) {
  const base = toFilename(wf.name);
  const filename = (nameCounts[base] > 1 ? `${base}-${wf.id}` : base) + '.json';
  const filepath = join(SERVER_DIR, filename);
  const prev = manifest[wf.id];

  // Skip if unchanged since last pull (unless --force)
  if (!force && prev && prev.updatedAt === wf.updatedAt && existsSync(filepath)) {
    newManifest[wf.id] = prev;
    skipped++;
    continue;
  }

  // Strip server-only metadata that isn't part of the importable workflow
  const { shared, activeVersion, activeVersionId, triggerCount, ...importable } = wf;

  writeFileSync(filepath, JSON.stringify(importable, null, 2) + '\n');

  // Handle filename changes (workflow renamed since last pull)
  if (prev && prev.filename !== filename) {
    console.log(`  ${prev.filename} → ${filename}  (renamed)`);
  } else {
    console.log(`  ${filename}`);
  }

  newManifest[wf.id] = { filename, updatedAt: wf.updatedAt, name: wf.name };
  downloaded++;
}

saveManifest(newManifest);

console.log(`\nDone. ${downloaded} downloaded, ${skipped} unchanged.`);
if (skipped > 0) console.log('Use --force to re-download all.');
