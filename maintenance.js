/**
 * maintenance.js
 *
 * Toggle maintenance mode via Upstash Redis. When active, the Notion
 * Webhook Router and Mailchimp Audience Hook accept webhooks (200 OK)
 * but silently drop all events — no downstream processing occurs.
 *
 * Usage:
 *   node maintenance.js on             # enable maintenance mode
 *   node maintenance.js on --ttl 3600  # enable with 1-hour auto-expire (seconds)
 *   node maintenance.js off            # disable maintenance mode
 *   node maintenance.js status         # check current state
 *
 * Requires .env with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
 */

import loadEnv from './lib/load-env.js';

const env = loadEnv({ required: true });

function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

const UPSTASH_URL = stripQuotes(env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = stripQuotes(env.UPSTASH_REDIS_REST_TOKEN);
const KEY = 'n8n:maintenance';

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in .env');
  process.exit(1);
}

async function redis(command) {
  const res = await fetch(`${UPSTASH_URL}/${command}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Redis ${command} failed: ${res.status} ${body}`);
  }
  return res.json();
}

const args = process.argv.slice(2);
const action = args[0];

if (action === 'on') {
  const ttlIdx = args.indexOf('--ttl');
  const ttl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1], 10) : null;

  if (ttl) {
    await redis(`SET/${KEY}/1/EX/${ttl}`);
    console.log(`Maintenance mode ON (auto-expires in ${ttl}s)`);
  } else {
    await redis(`SET/${KEY}/1`);
    console.log('Maintenance mode ON (no expiry — remember to turn it off!)');
  }
} else if (action === 'off') {
  await redis(`DEL/${KEY}`);
  console.log('Maintenance mode OFF');
} else if (action === 'status') {
  const result = await redis(`GET/${KEY}`);
  if (result.result) {
    const ttlResult = await redis(`TTL/${KEY}`);
    const ttl = ttlResult.result;
    if (ttl > 0) {
      console.log(`Maintenance mode is ON (expires in ${ttl}s)`);
    } else {
      console.log('Maintenance mode is ON (no expiry)');
    }
  } else {
    console.log('Maintenance mode is OFF');
  }
} else {
  console.error('Usage: node maintenance.js <on|off|status> [--ttl <seconds>]');
  process.exit(1);
}
