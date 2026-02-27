/**
 * Sub-workflow: Upsert Contact
 *
 * Called by other workflows to add or update a contact in the master
 * Notion contacts database.
 *
 * Input (from calling workflow):
 *   { email, first_name, last_name, company, email_marketing, tags,
 *     street_address, street_address_2, city, state, postal_code,
 *     country, phone }
 *
 * Logic:
 *   1. Validate that email is present — skip record if missing
 *   2. Look up existing contact by Identifier (email) in Notion
 *   3. "Mark" each stream: wrap incoming data under `incoming`, Notion
 *      data under `notion`, both keyed by `Identifier` (the email)
 *   4. Merge (outer join on Identifier) so every incoming record is
 *      paired with its Notion match (if any)
 *   5. If found → merge (prefer non-null incoming values) → build Notion
 *      API request body (only non-null properties) → HTTP PATCH to update
 *   6. If not found → build Notion API request body (only non-null
 *      properties) → HTTP POST to create
 *
 * After import into n8n:
 *   - Verify the "Eve Notion Account" credential is connected on the Lookup
 *     Contact node and both HTTP Request nodes (Update Contact, Create Contact)
 *   - Enable "Always Output Data" on the Lookup Contact node (Settings tab)
 *     so the Merge node always receives data on both inputs
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DATABASE_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';
const NOTION_CREDENTIAL = { notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' } };

// Map from incoming field names →
//   prop:      Notion property name (used when *writing* via propertiesUi)
//   notionKey: Notion simplified-output field name (used when *reading* getAll results)
//
// Notion v2.2 simplified output lowercases property names, replaces spaces
// with underscores, and prepends "property_".  e.g. "First name" → "property_first_name"
const FIELD_MAP = {
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
};

// Shared helper function (embedded in Code node strings) that converts a
// value + API type into the Notion API property format.
const TO_NOTION_PROP_FN = `
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
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Receive Contact',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: JSON.stringify({
      email: 'user@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
      company: 'Acme Inc',
      email_marketing: 'subscribed',
      tags: ['customer', 'vip'],
      street_address: '123 Main St',
      street_address_2: 'Suite 100',
      city: 'Springfield',
      state: 'IL',
      postal_code: '62701',
      country: 'US',
      phone: '+1-555-123-4567',
    }, null, 2),
  },
  { position: [250, 300], typeVersion: 1.1 },
);

// Gate: skip records that have no email — nothing useful to upsert.
const hasEmail = createNode(
  'Has Email?',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.email }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [500, 300], typeVersion: 2 },
);

// Query Notion for an existing contact whose Identifier matches the email.
const lookup = createNode(
  'Lookup Contact',
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
    filterType: 'manual',
    filters: {
      conditions: [
        {
          key: 'Identifier|title',
          condition: 'equals',
          titleValue: '={{ $json.email }}',
        },
      ],
    },
    options: {},
  },
  { position: [750, 200], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);

// Ensure the Merge node always receives data on input 0, even when all
// lookups return zero results.
lookup.settings = { alwaysOutputData: true };
lookup.alwaysOutputData = true;

// ---------------------------------------------------------------------------
// Mark each stream with a common Identifier key for field-based merging
// ---------------------------------------------------------------------------

// "Mark Existing" wraps the Notion lookup result under `notion` and tags
// the item with the email from the paired Has Email? output item.
// $('Has Email?').item correctly follows per-item pairing in expressions.
const markExisting = createNode(
  'Mark Existing',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'notion',
          value: '={{ $json }}',
          type: 'object',
        },
        {
          id: crypto.randomUUID(),
          name: 'Identifier',
          value: "={{ $('Has Email?').item.json.email }}",
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [950, 200], typeVersion: 3.4 },
);

// "Mark Inbound" wraps the original incoming data under `incoming` and
// extracts the email as `Identifier` (same field name as Mark Existing).
const markInbound = createNode(
  'Mark Inbound',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'incoming',
          value: '={{ $json }}',
          type: 'object',
        },
        {
          id: crypto.randomUUID(),
          name: 'Identifier',
          value: '={{ $json.email }}',
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [950, 400], typeVersion: 3.4 },
);

// ---------------------------------------------------------------------------
// Merge by Identifier (outer join) — pairs incoming data with Notion record
// ---------------------------------------------------------------------------
// Uses fieldsToMatchString to join on the shared Identifier field.
// joinMode "keepEverything" ensures that incoming records with no Notion
// match still pass through (they'll have `incoming` but no `notion`).
const pairRecords = createNode(
  'Pair Records',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    fieldsToMatchString: 'Identifier',
    joinMode: 'keepEverything',
    options: {},
  },
  { position: [1150, 300], typeVersion: 3 },
);

// Branch: does a matching contact already exist?
// Items with a `notion` object were found in the database.
// Items without one are new contacts.
const ifExists = createNode(
  'Contact Exists?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.notion}}',
          rightValue: '',
          operator: {
            type: 'object',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1350, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// True branch – merge incoming + existing, build Notion API body, then update
// ---------------------------------------------------------------------------

const BUILD_UPDATE_CODE = `
${TO_NOTION_PROP_FN}

function hasValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

function valuesEqual(a, b) {
  const emptyA = !hasValue(a);
  const emptyB = !hasValue(b);
  if (emptyA && emptyB) return true;
  if (emptyA !== emptyB) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

const fieldMap = ${JSON.stringify(FIELD_MAP, null, 2)};

const results = [];
for (const item of $input.all()) {
  const data = item.json;
  const properties = {};
  let changed = false;

  // Always include Identifier (title) — the page title / email
  properties['Identifier'] = toNotionProp('title', data.Identifier);

  for (const [inKey, mapping] of Object.entries(fieldMap)) {
    const newVal = data.incoming[inKey];
    const oldVal = data.notion[mapping.notionKey];
    const mergedVal = hasValue(newVal) ? newVal : (oldVal ?? null);

    if (!valuesEqual(mergedVal, oldVal)) changed = true;

    // Only include non-null properties in the API request body
    if (hasValue(mergedVal)) {
      properties[mapping.prop] = toNotionProp(mapping.apiType, mergedVal);
    }
  }

  if (changed) {
    results.push({
      json: {
        pageId: data.notion.id,
        requestBody: JSON.stringify({ properties }),
      },
    });
  }
}

return results;
`.trim();

const buildUpdateBody = createNode(
  'Build Update Body',
  'n8n-nodes-base.code',
  {
    jsCode: BUILD_UPDATE_CODE,
    mode: 'runOnceForAllItems',
  },
  { position: [1550, 200], typeVersion: 2 },
);

const update = createNode(
  'Update Contact',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.pageId }}',
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
    jsonBody: '={{ $json.requestBody }}',
    options: {},
  },
  { position: [1750, 200], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);

// ---------------------------------------------------------------------------
// False branch – build Notion API body and create a brand-new contact
// ---------------------------------------------------------------------------

// Build the Notion API create request body, including only non-null fields.
const BUILD_CREATE_CODE = `
${TO_NOTION_PROP_FN}

function hasValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

const DATABASE_ID = '${DATABASE_ID}';
const fieldMap = ${JSON.stringify(FIELD_MAP, null, 2)};

const results = [];
for (const item of $input.all()) {
  const data = item.json;
  const properties = {};

  // Always include Identifier (title) — required for page creation
  properties['Identifier'] = toNotionProp('title', data.Identifier);

  for (const [inKey, mapping] of Object.entries(fieldMap)) {
    const val = data.incoming[inKey];
    if (hasValue(val)) {
      properties[mapping.prop] = toNotionProp(mapping.apiType, val);
    }
  }

  results.push({
    json: {
      requestBody: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties,
      }),
    },
  });
}

return results;
`.trim();

const buildCreateBody = createNode(
  'Build Create Body',
  'n8n-nodes-base.code',
  {
    jsCode: BUILD_CREATE_CODE,
    mode: 'runOnceForAllItems',
  },
  { position: [1550, 400], typeVersion: 2 },
);

const create = createNode(
  'Create Contact',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
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
    jsonBody: '={{ $json.requestBody }}',
    options: {},
  },
  { position: [1750, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Master Contact Upsert', {
  nodes: [
    trigger, hasEmail, lookup, markExisting, markInbound,
    pairRecords, ifExists, buildUpdateBody, update, buildCreateBody, create,
  ],
  connections: [
    connect(trigger, hasEmail),
    connect(hasEmail, lookup),              // passes through only if email is present
    connect(hasEmail, markInbound),         // also wrap original data as { incoming, Identifier }
    connect(lookup, markExisting),          // wrap Notion result as { notion, Identifier }
    connect(markExisting, pairRecords, 0, 0),  // Notion data → Pair Records input 0
    connect(markInbound, pairRecords, 0, 1),   // incoming data → Pair Records input 1
    connect(pairRecords, ifExists),            // paired data → IF
    connect(ifExists, buildUpdateBody, 0, 0),   // true  → Build Update Body
    connect(buildUpdateBody, update),
    connect(ifExists, buildCreateBody, 1, 0),  // false → Build Create Body
    connect(buildCreateBody, create),          // → Create Contact (HTTP POST)
  ],
  tags: ['sub-workflow', 'contacts'],
});
