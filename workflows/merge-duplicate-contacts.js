/**
 * Merge Duplicate Contacts
 *
 * On-demand workflow that:
 *   1. Fetches all contacts from the Notion Master Contacts Database
 *   2. Identifies duplicate contacts by email
 *   3. Merges fields from source records into the destination record
 *   4. Unions all two-way relation references on the contact side (auto-syncs reverse)
 *   5. Archives (deletes) the source records
 *   6. Backs up deleted records to a CSV on Dropbox
 *   7. Outputs a detailed report of all actions taken
 *
 * Destination selection:
 *   - Oldest by created_time
 *
 * Field merging:
 *   - For unitary values (strings, dates, etc.): newest record's non-null value wins
 *   - If only one record has a value, it's used regardless of age
 *   - Tags (multi_select) = set union across all records
 *   - Relations = set union of page IDs across all records (all are two-way)
 *
 * Two-way relation properties (on Contacts side):
 *   Papers, Client db, Sales pipeline, Comms pipeline,
 *   Partner pipeline, WebDB: Book endorsements
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';

// Two-way relation properties on the Contacts side.
// prop = Notion display name (for API writes), key = simplified output field name (for reads).
const RELATION_FIELDS = [
  { prop: 'Papers', key: 'property_papers' },
  { prop: 'Client db', key: 'property_client_db' },
  { prop: 'Sales pipeline', key: 'property_sales_pipeline' },
  { prop: 'Comms pipeline', key: 'property_comms_pipeline' },
  { prop: 'Partner pipeline', key: 'property_partner_pipeline' },
  { prop: 'WebDB: Book endorsements', key: 'property_web_db_book_endorsements' },
];
const RELATION_FIELDS_JSON = JSON.stringify(RELATION_FIELDS);

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};
const DROPBOX_CREDENTIAL = {
  dropboxOAuth2Api: { id: '5p74zyJBc4pRsoO4', name: 'Dropbox account' },
};

const BACKUP_PATH = '=/Filing Cabinet/*Venn Factory/VF Contacts/deleted-contacts-{{ DateTime.now().toFormat("yyyy-MM-dd-HHmmss") }}.csv';

// Field map: incoming key → Notion property name, simplified output key, API type
const FIELD_MAP_JSON = JSON.stringify({
  email:            { prop: 'Email',            notionKey: 'property_email',            apiType: 'email' },
  first_name:       { prop: 'First name',       notionKey: 'property_first_name',       apiType: 'rich_text' },
  last_name:        { prop: 'Last name',        notionKey: 'property_last_name',        apiType: 'rich_text' },
  company:          { prop: 'Company Name',     notionKey: 'property_company_name',     apiType: 'rich_text' },
  email_marketing:  { prop: 'Email Marketing',  notionKey: 'property_email_marketing',  apiType: 'select' },
  tags:             { prop: 'Tags',             notionKey: 'property_tags',             apiType: 'multi_select' },
  street_address:   { prop: 'Street Address',   notionKey: 'property_street_address',   apiType: 'rich_text' },
  street_address_2: { prop: 'Address Line 2',   notionKey: 'property_address_line_2',   apiType: 'rich_text' },
  city:             { prop: 'City',             notionKey: 'property_city',             apiType: 'rich_text' },
  state:            { prop: 'State',            notionKey: 'property_state',            apiType: 'rich_text' },
  postal_code:      { prop: 'Postal Code',      notionKey: 'property_postal_code',      apiType: 'rich_text' },
  country:          { prop: 'Country',          notionKey: 'property_country',          apiType: 'rich_text' },
  phone:            { prop: 'Phone',            notionKey: 'property_phone',            apiType: 'phone_number' },
});

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
  { position: [474, 300], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getAllContacts.retryOnFail = true;
getAllContacts.maxTries = 3;
getAllContacts.waitBetweenTries = 1000;

// ---------------------------------------------------------------------------
// Find Duplicates
// ---------------------------------------------------------------------------
// Groups contacts by email, identifies duplicates, picks destinations,
// collects source IDs, and builds a targeted pipeline query filter.
// Outputs a single item with the full plan data + query body.
// Returns 0 items if no duplicates found.
// ---------------------------------------------------------------------------

const findDuplicates = createNode(
  'Find Duplicates',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const FIELD_MAP = ${FIELD_MAP_JSON};
const RELATION_FIELDS = ${RELATION_FIELDS_JSON};

// --- Helpers ---

function hasValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

// --- Parse contacts ---

const allItems = $input.all();
const contacts = [];

for (const item of allItems) {
  const j = item.json;
  if (!j.id || (j.property_email === undefined && j.property_identifier === undefined)) continue;

  const record = {
    id: j.id,
    url: j.url,
    created_time: j.property_created_time,
    email: (j.property_email || j.property_identifier || '').toString().trim().toLowerCase(),
  };

  // Standard fields
  for (const [key, mapping] of Object.entries(FIELD_MAP)) {
    record[mapping.notionKey] = j[mapping.notionKey] ?? null;
  }

  // Relation fields — simplified output returns arrays of strings (page IDs)
  // or arrays of objects with .id; handle both
  for (const rel of RELATION_FIELDS) {
    const raw = j[rel.key] || [];
    record[rel.key] = raw.map(p => typeof p === 'string' ? p : (p && p.id ? p.id : null)).filter(Boolean);
  }

  contacts.push(record);
}

// --- Group by email ---

const byEmail = new Map();
for (const contact of contacts) {
  if (!contact.email) continue;
  if (!byEmail.has(contact.email)) byEmail.set(contact.email, []);
  byEmail.get(contact.email).push(contact);
}

const duplicateGroups = [];
const allSourceIds = [];

for (const [email, records] of byEmail) {
  if (records.length < 2) continue;

  // Destination = oldest by created_time
  records.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  const dest = records[0];
  const sources = records.slice(1);

  for (const src of sources) {
    allSourceIds.push(src.id);
  }

  duplicateGroups.push({ email, dest, sources, allRecords: records });
}

if (duplicateGroups.length === 0) {
  return []; // No duplicates — downstream nodes receive 0 items
}

return [{
  json: {
    _type: 'duplicate_plan',
    groups: duplicateGroups,
    sourceIds: allSourceIds,
  },
}];`,
  },
  { position: [698, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Build Merge Plan
// ---------------------------------------------------------------------------
// Receives plan item (_type === 'duplicate_plan') from Find Duplicates.
// Computes merged fields, relation unions, and outputs mutation items
// (update_contact + archive_source) for the Execute on Notion HTTP node.
// ---------------------------------------------------------------------------

const buildMergePlan = createNode(
  'Build Merge Plan',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const FIELD_MAP = ${FIELD_MAP_JSON};
const RELATION_FIELDS = ${RELATION_FIELDS_JSON};
const NOTION_API = 'https://api.notion.com/v1';

// --- Helpers ---

function hasValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

function toNotionProp(apiType, value) {
  switch (apiType) {
    case 'title':        return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':    return { rich_text: [{ text: { content: String(value) } }] };
    case 'email':        return { email: String(value) };
    case 'phone_number': return { phone_number: String(value) };
    case 'select':       return { select: { name: String(value) } };
    case 'multi_select': return { multi_select: (Array.isArray(value) ? value : [value]).map(v => ({ name: String(v) })) };
    default: throw new Error('Unknown apiType: ' + apiType);
  }
}

// --- Step 1: Extract plan data ---

const allItems = $input.all();
let plan = null;

for (const item of allItems) {
  if (item.json._type === 'duplicate_plan') {
    plan = item.json;
    break;
  }
}

if (!plan || plan.groups.length === 0) {
  return []; // No duplicates — downstream nodes receive 0 items
}

// --- Step 2: For each group, compute merged fields and build mutations ---

const outputItems = [];

for (let groupIdx = 0; groupIdx < plan.groups.length; groupIdx++) {
  const group = plan.groups[groupIdx];
  const dest = group.dest;
  const sources = group.sources;
  const allRecords = group.allRecords;

  // --- Merge standard fields ---
  const mergedProps = {};
  const fieldsMerged = [];

  for (const [key, mapping] of Object.entries(FIELD_MAP)) {
    const destVal = dest[mapping.notionKey];

    if (mapping.apiType === 'multi_select') {
      // Tags: set union across all records
      const allTags = new Set();
      for (const rec of allRecords) {
        const val = rec[mapping.notionKey];
        if (Array.isArray(val)) val.forEach(t => allTags.add(String(t)));
      }
      if (allTags.size > 0) {
        mergedProps[mapping.prop] = toNotionProp('multi_select', [...allTags]);
        const destTags = new Set(Array.isArray(destVal) ? destVal.map(String) : []);
        if (allTags.size > destTags.size) fieldsMerged.push(key);
      }
    } else {
      // Unitary fields: newest record's non-null value wins
      let finalVal = null;
      let mergedFrom = null;
      let newestTime = null;
      for (const rec of allRecords) {
        const val = rec[mapping.notionKey];
        if (hasValue(val)) {
          const recTime = new Date(rec.created_time).getTime();
          if (newestTime === null || recTime > newestTime) {
            finalVal = val;
            newestTime = recTime;
            mergedFrom = rec.id !== dest.id ? rec.id : null;
          }
        }
      }
      if (hasValue(finalVal)) {
        mergedProps[mapping.prop] = toNotionProp(mapping.apiType, finalVal);
        if (mergedFrom) fieldsMerged.push(key);
      }
    }
  }

  // Default email_marketing to Subscribed if no record had a value
  if (!mergedProps['Email Marketing']) {
    mergedProps['Email Marketing'] = toNotionProp('select', 'Subscribed');
  }

  mergedProps['Identifier'] = toNotionProp('title', group.email);

  // --- Relation unions ---
  // All relations are two-way — updating the contact side auto-syncs the reverse.
  const relationsChanged = [];

  for (const rel of RELATION_FIELDS) {
    const union = new Set();
    for (const rec of allRecords) {
      const ids = rec[rel.key];
      if (Array.isArray(ids)) ids.forEach(id => union.add(id));
    }
    if (union.size > 0) {
      mergedProps[rel.prop] = { relation: [...union].map(id => ({ id })) };
      const destIds = new Set(dest[rel.key] || []);
      if (union.size > destIds.size) relationsChanged.push(rel.prop);
    }
  }

  // --- Mutation items ---

  // 1. Update destination contact with merged fields + relation unions
  outputItems.push({
    json: {
      url: NOTION_API + '/pages/' + dest.id,
      body: JSON.stringify({ properties: mergedProps }),
      _meta: {
        action: 'update_contact',
        groupIdx,
        email: group.email,
        pageId: dest.id,
        destUrl: dest.url,
        fieldsMerged,
        sourceCount: sources.length,
        relationsChanged,
      },
    },
  });

  // 2. Archive source records
  for (const src of sources) {
    const sourceRecord = {
      id: src.id,
      url: src.url,
      email: src.email,
      created_time: src.created_time,
    };
    for (const [key, mapping] of Object.entries(FIELD_MAP)) {
      sourceRecord[key] = src[mapping.notionKey] ?? '';
    }

    outputItems.push({
      json: {
        url: NOTION_API + '/pages/' + src.id,
        body: JSON.stringify({ archived: true }),
        _meta: {
          action: 'archive_source',
          groupIdx,
          email: group.email,
          pageId: src.id,
          sourceUrl: src.url,
          sourceRecord,
        },
      },
    });
  }
}

return outputItems;`,
  },
  { position: [922, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Test mode gate: disable this node in the n8n UI for a full production run
// ---------------------------------------------------------------------------
// When ENABLED, selects the smallest set of duplicate groups that covers both
// action types (update_contact, archive_source).
// When DISABLED, n8n passes all items through unchanged — full run.

const limitToTestSet = createNode(
  'Limit to Test Set',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const MAX_GROUPS = 3;

const allItems = $input.all();
if (allItems.length === 0) return [];

// Determine which action types each group produces
const groupActions = new Map();
for (const item of allItems) {
  const gi = item.json._meta.groupIdx;
  if (!groupActions.has(gi)) groupActions.set(gi, new Set());
  groupActions.get(gi).add(item.json._meta.action);
}

// Greedily select groups covering the most uncovered action types
const allActionTypes = ['update_contact', 'archive_source'];
const selectedGroups = new Set();
const coveredActions = new Set();
const ranked = [...groupActions.entries()]
  .sort((a, b) => b[1].size - a[1].size);

for (const [gi, actions] of ranked) {
  if (coveredActions.size >= allActionTypes.length) break;
  if (selectedGroups.size >= MAX_GROUPS) break;
  const newActions = [...actions].filter(a => !coveredActions.has(a));
  if (newActions.length > 0) {
    selectedGroups.add(gi);
    actions.forEach(a => coveredActions.add(a));
  }
}

// Filter to only selected groups
const totalBefore = allItems.length;
const totalGroups = groupActions.size;
const outputItems = allItems.filter(item =>
  selectedGroups.has(item.json._meta.groupIdx)
);

// Tag items so Build Report can indicate test mode
const uncovered = allActionTypes.filter(a => !coveredActions.has(a));
for (const item of outputItems) {
  item.json._meta._testMode = true;
  item.json._meta._testSummary = 'TEST MODE: ' + selectedGroups.size + '/' + totalGroups
    + ' groups, ' + outputItems.length + '/' + totalBefore + ' API calls'
    + (uncovered.length > 0 ? '. Not covered: ' + uncovered.join(', ') : '. All action types covered');
}

return outputItems;`,
  },
  { position: [1146, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Backup branch: extract archive records → CSV → Dropbox
// ---------------------------------------------------------------------------

const buildBackup = createNode(
  'Build Backup CSV',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const items = $input.all();
const archiveItems = items.filter(i => i.json._meta?.action === 'archive_source');

if (archiveItems.length === 0) return [];

return archiveItems.map(i => {
  const src = i.json._meta.sourceRecord;
  return {
    json: {
      id: src.id,
      url: src.url,
      email: src.email,
      first_name: src.first_name || '',
      last_name: src.last_name || '',
      company: src.company || '',
      email_marketing: src.email_marketing || '',
      tags: Array.isArray(src.tags) ? src.tags.join(', ') : (src.tags || ''),
      phone: src.phone || '',
      street_address: src.street_address || '',
      city: src.city || '',
      state: src.state || '',
      postal_code: src.postal_code || '',
      country: src.country || '',
      created_time: src.created_time || '',
    },
  };
});`,
  },
  { position: [1370, 100], typeVersion: 2 },
);
buildBackup.alwaysOutputData = true;

const convertToCsv = createNode(
  'Convert to CSV',
  'n8n-nodes-base.convertToFile',
  {
    operation: 'csv',
    options: {
      fileName: 'deleted-contacts-backup.csv',
    },
  },
  { position: [1594, 100], typeVersion: 1.1 },
);

const uploadBackup = createNode(
  'Upload Backup to Dropbox',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'upload',
    path: BACKUP_PATH,
    binaryData: true,
    binaryPropertyName: 'data',
    overwrite: true,
  },
  { position: [1818, 100], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);

// ---------------------------------------------------------------------------
// Execution branch: HTTP PATCH → Merge with plan context → Report
// ---------------------------------------------------------------------------

const executeOnNotion = createNode(
  'Execute on Notion',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '={{ $json.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Notion-Version', value: '2022-06-28' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.body }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [1370, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
executeOnNotion.retryOnFail = true;
executeOnNotion.maxTries = 3;
executeOnNotion.waitBetweenTries = 1000;
executeOnNotion.continueOnFail = true;

const combineResults = createNode(
  'Combine Results',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [1594, 400], typeVersion: 3 },
);

const buildReport = createNode(
  'Build Report',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const items = $input.all();

if (items.length === 0) {
  return [{ json: { _type: 'summary', message: 'No duplicates found — nothing to merge.' } }];
}

const results = [];
const groupMap = new Map();

for (const item of items) {
  const meta = item.json._meta;
  if (!meta) continue;

  const key = meta.groupIdx;
  if (!groupMap.has(key)) {
    groupMap.set(key, {
      email: meta.email,
      destId: null,
      destUrl: null,
      fieldsMerged: [],
      relationsChanged: [],
      sourcesArchived: [],
      errors: [],
    });
  }
  const g = groupMap.get(key);

  const hasError = item.json.error || item.json.statusCode >= 400;

  if (meta.action === 'update_contact') {
    g.destId = meta.pageId;
    g.destUrl = meta.destUrl;
    g.fieldsMerged = meta.fieldsMerged || [];
    g.relationsChanged = meta.relationsChanged || [];
    if (hasError) g.errors.push({ action: 'update_contact', pageId: meta.pageId, error: item.json.error || item.json.message || 'HTTP ' + item.json.statusCode });
  } else if (meta.action === 'archive_source') {
    g.sourcesArchived.push({ pageId: meta.pageId, url: meta.sourceUrl });
    if (hasError) g.errors.push({ action: 'archive_source', pageId: meta.pageId, error: item.json.error || item.json.message || 'HTTP ' + item.json.statusCode });
  }
}

let totalArchived = 0;
let totalErrors = 0;

for (const g of groupMap.values()) {
  totalArchived += g.sourcesArchived.length;
  totalErrors += g.errors.length;
}

results.push({
  json: {
    _type: 'summary',
    duplicateGroups: groupMap.size,
    recordsArchived: totalArchived,
    errors: totalErrors,
    message: totalErrors === 0
      ? 'All merges completed successfully.'
      : totalErrors + ' error(s) encountered — check group details.',
  },
});

for (const [idx, g] of groupMap) {
  results.push({
    json: {
      _type: 'merge',
      email: g.email,
      destId: g.destId,
      destUrl: g.destUrl,
      fieldsMerged: g.fieldsMerged,
      relationsChanged: g.relationsChanged,
      sourcesArchived: g.sourcesArchived,
      status: g.errors.length === 0 ? 'success' : 'partial_failure',
      errors: g.errors,
    },
  });
}

return results;`,
  },
  { position: [1818, 400], typeVersion: 2 },
);
buildReport.alwaysOutputData = true;

const aggregateReport = createNode(
  'Aggregate Report',
  'n8n-nodes-base.aggregate',
  {
    aggregate: 'aggregateAllItemData',
    destinationFieldName: 'report',
    options: {},
  },
  { position: [2042, 400], typeVersion: 1 },
);

const REPORT_PATH = '=/Filing Cabinet/*Venn Factory/VF Contacts/merge-report-{{ DateTime.now().toFormat("yyyy-MM-dd-HHmmss") }}.json';

const uploadReport = createNode(
  'Upload Report to Dropbox',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'upload',
    path: REPORT_PATH,
    fileContent: '={{ JSON.stringify($json.report, null, 2) }}',
    overwrite: true,
  },
  { position: [2266, 400], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);

// ---------------------------------------------------------------------------
// Assemble Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Merge Duplicate Contacts', {
  nodes: [
    manualTrigger, getAllContacts,
    findDuplicates, buildMergePlan, limitToTestSet,
    buildBackup, convertToCsv, uploadBackup,
    executeOnNotion, combineResults, buildReport,
    aggregateReport, uploadReport,
  ],
  connections: [
    // Data gathering: trigger → contacts → find duplicates → build merge plan
    connect(manualTrigger, getAllContacts),
    connect(getAllContacts, findDuplicates),
    connect(findDuplicates, buildMergePlan),

    // Test gate: disable "Limit to Test Set" in the UI for a full run
    connect(buildMergePlan, limitToTestSet),

    // Backup branch: plan → build backup rows → CSV → Dropbox
    connect(limitToTestSet, buildBackup),
    connect(buildBackup, convertToCsv),
    connect(convertToCsv, uploadBackup),

    // Execution branch: plan → HTTP PATCH → combine with plan context → report → Dropbox
    connect(limitToTestSet, executeOnNotion),
    connect(executeOnNotion, combineResults, 0, 0),   // HTTP responses → Merge input 0
    connect(limitToTestSet, combineResults, 0, 1),     // Plan items → Merge input 1 (context)
    connect(combineResults, buildReport),
    connect(buildReport, aggregateReport),
    connect(aggregateReport, uploadReport),
  ],
  tags: ['contacts', 'Utility'],
});
