/**
 * setup-qstash-topics.js
 *
 * Creates QStash URL Groups (topics) and registers adapter webhook URLs as endpoints.
 * One topic per Notion database, each with its adapter's webhook URL.
 *
 * Usage:
 *   node setup-qstash-topics.js             # create topics and register endpoints
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
const N8N_BASE_URL = env.N8N_BASE_URL;

if (!QSTASH_URL || !QSTASH_TOKEN) {
  console.error('Missing QSTASH_URL or QSTASH_TOKEN in .env');
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
const TOPICS = [
  {
    topic: 'notion-contacts',
    databaseId: '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd',
    endpoints: ['adapter-contacts'],
  },
  {
    topic: 'notion-clients',
    databaseId: '39b8f7e7-a5a2-4776-b78e-7ab77e8e5313',
    endpoints: ['adapter-clients'],
  },
  {
    topic: 'notion-partners',
    databaseId: '642b44e9-f325-45d7-87e7-f83a7e4c9b40',
    endpoints: ['adapter-partners'],
  },
  {
    topic: 'notion-appearances',
    databaseId: '35d10c83-92e6-4ce2-adc2-8c03e2c97480',
    endpoints: ['adapter-appearances', 'adapter-comms-pipeline'],
  },
  {
    topic: 'notion-downloads',
    databaseId: '1148ebaf-15ee-80ba-889c-f2c54aa25e84',
    endpoints: ['adapter-downloads'],
  },
  {
    topic: 'notion-testimonials',
    databaseId: 'aa848058-52f5-409f-8680-93024b34786a',
    endpoints: ['adapter-testimonials'],
  },
  {
    topic: 'notion-engagements',
    databaseId: '1c68ebaf-15ee-8073-be88-e8b8debc32f6',
    endpoints: ['adapter-engagements'],
  },
  {
    topic: 'notion-products',
    databaseId: '1d48ebaf-15ee-80b2-8e6f-ca20d5ddd6c7',
    endpoints: ['adapter-products'],
  },
  {
    topic: 'notion-endorsements',
    databaseId: '3028ebaf-15ee-80dc-89c3-e26f1f501ebe',
    endpoints: ['adapter-endorsements'],
  },
  {
    topic: 'notion-sales-pipeline',
    databaseId: '2ed21e43-3c29-4553-bdee-4a02a5bcbb4c',
    endpoints: ['adapter-sales-pipeline'],
  },
  {
    topic: 'notion-partner-pipeline',
    databaseId: '457cfa4c-93f4-4d10-93dc-2efbfa3e9a02',
    endpoints: ['adapter-partner-pipeline'],
  },
  {
    topic: 'notion-activities',
    databaseId: '3178ebaf-15ee-803f-bf71-e30bfc97b2b8',
    endpoints: ['adapter-activities'],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('QStash Topic Setup');
console.log(`  QStash: ${QSTASH_URL}`);
console.log(`  n8n:    ${N8N_BASE_URL}`);
console.log(`  Topics: ${TOPICS.length}`);
if (dryRun) console.log('  Mode:   DRY RUN\n');
else console.log('');

let created = 0;
let errors = 0;

for (const { topic, databaseId, endpoints } of TOPICS) {
  const webhookUrls = endpoints.map(path => `${N8N_BASE_URL}/webhook/${path}`);

  console.log(`  ${topic} (DB: ${databaseId.substring(0, 8)}...)`);
  for (const url of webhookUrls) {
    console.log(`    → ${url}`);
  }

  if (dryRun) {
    created++;
    continue;
  }

  try {
    // POST /v2/topics/{name}/endpoints — creates the topic if it doesn't exist
    // and adds/updates the endpoint URLs
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
      errors++;
      continue;
    }

    console.log(`    OK`);
    created++;
  } catch (err) {
    console.error(`    ERROR: ${err.message}`);
    errors++;
  }
}

console.log(`\nDone. ${created} topic(s) configured, ${errors} error(s).`);
if (dryRun) console.log('(dry run — no changes made)');
if (errors > 0) process.exit(1);
