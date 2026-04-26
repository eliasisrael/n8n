/**
 * list-mandrill-templates.js
 *
 * List all Mailchimp Transactional templates ("mctemplates") in the Mandrill
 * account. These are the templates referenced by integer mc_template_id and
 * sent via /messages/send-mc-template — distinct from native Mandrill
 * templates (slugs, /messages/send-template, /templates/list), which we don't
 * use here.
 *
 * Usage:
 *   op run --env-file=.env.tpl -- node list-mandrill-templates.js
 *   op run --env-file=.env.tpl -- node list-mandrill-templates.js --search MDID
 *   op run --env-file=.env.tpl -- node list-mandrill-templates.js --json
 *
 * Flags:
 *   --search <q>  optional Mandrill search query
 *   --json        dump the raw API response instead of the formatted table
 *
 * Requires MANDRILL_API_KEY in env (via 1Password op run).
 */

import loadEnv from './lib/load-env.js';

const env = loadEnv({ required: true });

const MANDRILL_API_KEY = env.MANDRILL_API_KEY;
if (!MANDRILL_API_KEY) {
  console.error('Missing MANDRILL_API_KEY in .env');
  process.exit(1);
}

function getFlag(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const search = getFlag('search');
const asJson = hasFlag('json');

const body = { key: MANDRILL_API_KEY };
if (search) body.search_query = search;

const res = await fetch('https://mandrillapp.com/api/1.4/mctemplates/list', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = text; }

if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(JSON.stringify(parsed, null, 2));
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(parsed, null, 2));
  process.exit(0);
}

if (!Array.isArray(parsed)) {
  console.error('Unexpected response shape:');
  console.error(JSON.stringify(parsed, null, 2));
  process.exit(1);
}

if (parsed.length === 0) {
  console.log(search ? `No templates match "${search}".` : 'No mctemplates in account.');
  process.exit(0);
}

// Sort by published_at (most recently published first), nulls last.
parsed.sort((a, b) => {
  const ap = a.published_at || '';
  const bp = b.published_at || '';
  if (!ap && !bp) return 0;
  if (!ap) return 1;
  if (!bp) return -1;
  return bp.localeCompare(ap);
});

const idWidth = Math.max(2, ...parsed.map(t => String(t.mc_template_id || '').length));
const nameWidth = Math.max(4, ...parsed.map(t => (t.mc_template_name || '').length));

const pad = (s, n) => String(s ?? '').padEnd(n);

console.log(`${pad('ID', idWidth)}  ${pad('NAME', nameWidth)}  PUBLISHED`);
console.log('-'.repeat(idWidth + nameWidth + 25));
for (const t of parsed) {
  const published = t.published_at || '(draft only)';
  console.log(`${pad(t.mc_template_id, idWidth)}  ${pad(t.mc_template_name, nameWidth)}  ${published}`);
}
console.log(`\n${parsed.length} mctemplate(s).`);
