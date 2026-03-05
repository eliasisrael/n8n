/**
 * Find Duplicate Contacts
 *
 * On-demand workflow that scans all records in the Notion Master Contact
 * Database, groups them by email address (case-insensitive), and reports
 * any duplicates in the execution output.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const DATABASE_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';
const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const manualTrigger = createNode(
  'Run Manually',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [250, 300] },
);

const getAllContacts = createNode(
  'Get All Contacts',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      mode: 'id',
      value: DATABASE_ID,
    },
    returnAll: true,
    filterType: 'none',
    options: {},
  },
  { position: [550, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);

const findDuplicates = createNode(
  'Find Duplicates',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const items = $input.all();
const byEmail = new Map();

for (const item of items) {
  const email = (item.json.property_email || item.json.property_identifier || '').toString().trim().toLowerCase();
  if (!email) continue;

  if (!byEmail.has(email)) {
    byEmail.set(email, []);
  }
  byEmail.get(email).push({
    id: item.json.id,
    url: item.json.url,
    identifier: item.json.property_identifier || '',
    first_name: item.json.property_first_name || '',
    last_name: item.json.property_last_name || '',
    company: item.json.property_company_name || '',
  });
}

const duplicates = [];
for (const [email, records] of byEmail.entries()) {
  if (records.length >= 2) {
    duplicates.push({ email, count: records.length, records });
  }
}

// Sort by count descending, then by email
duplicates.sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));

const totalScanned = items.length;
const duplicateEmails = duplicates.length;
const duplicateRecords = duplicates.reduce((sum, d) => sum + d.count, 0);

if (duplicates.length === 0) {
  return [{ json: { message: 'No duplicates found', totalScanned } }];
}

const results = [
  {
    json: {
      _type: 'summary',
      totalScanned,
      duplicateEmails,
      duplicateRecords,
      message: \`Found \${duplicateEmails} email(s) with duplicates (\${duplicateRecords} total records)\`,
    },
  },
  ...duplicates.map(d => ({ json: { _type: 'duplicate', ...d } })),
];

return results;`,
  },
  { position: [850, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Assemble Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Find Duplicate Contacts', {
  nodes: [manualTrigger, getAllContacts, findDuplicates],
  connections: [
    connect(manualTrigger, getAllContacts),
    connect(getAllContacts, findDuplicates),
  ],
  tags: ['contacts', 'Utility'],
});
