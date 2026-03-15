/**
 * setup-qstash-topics.js
 *
 * Creates QStash URL Groups (topics) and registers adapter webhook URLs as endpoints.
 * Also writes database-ID-to-topic-name mappings to Redis (dbtopic:{db_id} → topic_name)
 * so the router can look up the correct topic at runtime without a hardcoded map.
 *
 * Usage:
 *   node setup-qstash-topics.js             # create topics, register endpoints, write Redis mappings
 *   node setup-qstash-topics.js --dry-run   # preview without applying
 */

import loadEnv from './lib/load-env.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = loadEnv({ required: true });

function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

const QSTASH_URL = stripQuotes(env.QSTASH_URL);
const QSTASH_TOKEN = stripQuotes(env.QSTASH_TOKEN);
const UPSTASH_URL = stripQuotes(env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = stripQuotes(env.UPSTASH_REDIS_REST_TOKEN);
const N8N_BASE_URL = env.N8N_BASE_URL;

if (!QSTASH_URL || !QSTASH_TOKEN) {
  console.error('Missing QSTASH_URL or QSTASH_TOKEN in .env');
  process.exit(1);
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in .env');
  process.exit(1);
}
if (!N8N_BASE_URL) {
  console.error('Missing N8N_BASE_URL in .env');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Topic → Adapter mapping
// ---------------------------------------------------------------------------
// Database IDs are the ground-truth values from the router's Switch node
// (these are what body.data.parent.id contains in webhook payloads).
const TOPICS = [
  {
    topic: 'notion-contacts',
    databaseId: '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd',
    endpoints: ['adapter-contacts'],
  },
  {
    topic: 'notion-clients',
    databaseId: '39b8f7e7-362f-4121-8389-4d9f5c26c1d4',
    endpoints: ['adapter-clients'],
  },
  {
    topic: 'notion-partners',
    databaseId: '642b44e9-1363-4765-aaaf-702a708d6812',
    endpoints: ['adapter-partners'],
  },
  {
    topic: 'notion-appearances',
    databaseId: '35d10c83-92e6-4ce2-adc2-8c03e2c97480',
    endpoints: ['adapter-appearances', 'adapter-comms-pipeline'],
  },
  {
    topic: 'notion-testimonials',
    databaseId: 'aa848058-0b30-4782-bcc1-f56be736399e',
    endpoints: ['adapter-testimonials'],
  },
  {
    topic: 'notion-engagements',
    databaseId: '1c68ebaf-15ee-8062-80b2-fcb378557689',
    endpoints: ['adapter-engagements'],
  },
  {
    topic: 'notion-products',
    databaseId: '1d48ebaf-15ee-80c4-a8e7-d99c0596d520',
    endpoints: ['adapter-products'],
  },
  {
    topic: 'notion-endorsements',
    databaseId: '3028ebaf-15ee-8023-82ae-c94c75e1aa4d',
    endpoints: ['adapter-endorsements'],
  },
  {
    topic: 'notion-sales-pipeline',
    databaseId: '2ed21e43-d3a5-45f4-8cf4-a2a8f61a264f',
    endpoints: ['adapter-sales-pipeline'],
  },
  {
    topic: 'notion-partner-pipeline',
    databaseId: '457cfa4c-123b-4718-a7d3-c8bf7ea4a27e',
    endpoints: ['adapter-partner-pipeline'],
  },
  {
    topic: 'notion-activities',
    databaseId: '3178ebaf-15ee-803f-bf71-e30bfc97b2b8',
    endpoints: ['adapter-activities'],
  },
  {
    topic: 'notion-vf-notes',
    databaseId: '28b58533-efd7-4018-a8d5-665b6755b90d',
    endpoints: ['adapter-vf-notes'],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('QStash Topic + Redis Mapping Setup');
console.log(`  QStash: ${QSTASH_URL}`);
console.log(`  Redis:  ${UPSTASH_URL}`);
console.log(`  n8n:    ${N8N_BASE_URL}`);
console.log(`  Topics: ${TOPICS.length}`);
if (dryRun) console.log('  Mode:   DRY RUN\n');
else console.log('');

// ---------------------------------------------------------------------------
// 1. Register QStash URL Groups
// ---------------------------------------------------------------------------
console.log('=== QStash URL Groups ===\n');

let topicOk = 0;
let topicErr = 0;

for (const { topic, databaseId, endpoints } of TOPICS) {
  const webhookUrls = endpoints.map(path => `${N8N_BASE_URL}/webhook/${path}`);

  console.log(`  ${topic} (DB: ${databaseId.substring(0, 8)}...)`);
  for (const url of webhookUrls) {
    console.log(`    → ${url}`);
  }

  if (dryRun) {
    topicOk++;
    continue;
  }

  try {
    const res = await fetch(`${QSTASH_URL}/v2/topics/${topic}/endpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${QSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endpoints: webhookUrls.map(url => ({ url })),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`    ERROR (${res.status}): ${body}`);
      topicErr++;
      continue;
    }

    console.log(`    OK`);
    topicOk++;
  } catch (err) {
    console.error(`    ERROR: ${err.message}`);
    topicErr++;
  }
}

console.log(`\n  ${topicOk} topic(s) configured, ${topicErr} error(s).\n`);

// ---------------------------------------------------------------------------
// 2. Write Redis dbtopic:{db_id} → topic_name mappings
// ---------------------------------------------------------------------------
console.log('=== Redis Topic Mappings ===\n');

let redisOk = 0;
let redisErr = 0;

for (const { topic, databaseId } of TOPICS) {
  const key = `dbtopic:${databaseId}`;
  console.log(`  SET ${key} → ${topic}`);

  if (dryRun) {
    redisOk++;
    continue;
  }

  try {
    const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`    ERROR (${res.status}): ${body}`);
      redisErr++;
      continue;
    }

    console.log(`    OK`);
    redisOk++;
  } catch (err) {
    console.error(`    ERROR: ${err.message}`);
    redisErr++;
  }
}

console.log(`\n  ${redisOk} mapping(s) written, ${redisErr} error(s).`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totalErrors = topicErr + redisErr;
console.log(`\nDone. ${topicOk} topics, ${redisOk} Redis mappings, ${totalErrors} error(s).`);
if (dryRun) console.log('(dry run — no changes made)');
if (totalErrors > 0) process.exit(1);
