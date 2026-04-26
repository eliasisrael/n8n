/**
 * test-mandrill-template.js
 *
 * Send a single transactional email via Mandrill's /messages/send-mc-template
 * endpoint to verify that a template renders FNAME / EMAIL merge fields
 * correctly. Bypasses n8n entirely — direct API call so we can iterate on
 * Mailchimp Transactional templates without touching the workflow.
 *
 * Usage:
 *   op run --env-file=.env.tpl -- node test-mandrill-template.js \
 *     --to eli@example.com \
 *     --id 10119870 \
 *     --fname Eli
 *
 * Flags:
 *   --to     (required) recipient email
 *   --id     (optional) mc_template_id; defaults to 10119870 (Book Eve To Speak)
 *   --fname  (optional) FNAME merge var; defaults to "Friend"
 *   --version (optional) "published" or "draft"; defaults to "published"
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

const to       = getFlag('to');
const id       = parseInt(getFlag('id', '10119870'), 10);
const fname    = getFlag('fname', 'Friend');
const version  = getFlag('version', 'published');

if (!to) {
  console.error('Missing --to <email>');
  process.exit(1);
}
if (!Number.isFinite(id)) {
  console.error('--id must be a numeric mc_template_id');
  process.exit(1);
}

const body = {
  key: MANDRILL_API_KEY,
  mc_template_id: id,
  mc_template_version: version,
  message: {
    to: [{ email: to, type: 'to' }],
    bcc_address: 'eve@vennfactory.com',
    merge: true,
    merge_language: 'mailchimp',
    // Mailchimp Transactional templates only honor global_merge_vars, not
    // per-recipient merge_vars. Single-recipient sends work either way for
    // delivery, but only globals get substituted into the template body.
    global_merge_vars: [
      { name: 'FNAME', content: fname },
      { name: 'EMAIL', content: to },
    ],
  },
};

console.log(`Sending mc_template_id=${id} (${version}) to ${to} (FNAME="${fname}")`);

const res = await fetch('https://mandrillapp.com/api/1.4/messages/send-mc-template', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = text; }

console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(parsed, null, 2));

if (!res.ok) process.exit(1);

// Mandrill returns an array of result objects — one per recipient.
if (Array.isArray(parsed)) {
  const rejected = parsed.filter(r => !['sent', 'queued', 'scheduled'].includes(r.status));
  if (rejected.length > 0) {
    console.error(`\n${rejected.length} recipient(s) rejected:`);
    for (const r of rejected) console.error(`  ${r.email}: ${r.status} (${r.reject_reason || 'no reason given'})`);
    process.exit(1);
  }
}
