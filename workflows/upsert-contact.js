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
 *   3. If found → merge (prefer non-null incoming values) → update
 *   4. If not found → create new record
 *
 * After import into n8n:
 *   - Connect the Notion credential on each Notion node
 *   - Verify the database is selected and property mappings look correct
 *   - Enable "Always Output Data" on the Lookup Contact node (Settings tab)
 *     so the IF node runs even when no matching contact is found
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DATABASE_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';

// Map from incoming field names →
//   prop:      Notion property name (used when *writing* via propertiesUi)
//   notionKey: Notion simplified-output field name (used when *reading* getAll results)
//
// Notion v2.2 simplified output lowercases property names, replaces spaces
// with underscores, and prepends "property_".  e.g. "First name" → "property_first_name"
const FIELD_MAP = {
  email:            { prop: 'Email',            notionKey: 'property_email' },
  first_name:       { prop: 'First name',       notionKey: 'property_first_name' },
  last_name:        { prop: 'Last name',        notionKey: 'property_last_name' },
  company:          { prop: 'Company Name',     notionKey: 'property_company_name' },
  email_marketing:  { prop: 'Email Marketing',  notionKey: 'property_email_marketing' },
  tags:             { prop: 'Tags',             notionKey: 'property_tags' },
  street_address:   { prop: 'Street Address',   notionKey: 'property_street_address' },
  street_address_2: { prop: 'Address Line 2',   notionKey: 'property_address_line_2' },
  city:             { prop: 'City',             notionKey: 'property_city' },
  state:            { prop: 'State',            notionKey: 'property_state' },
  postal_code:      { prop: 'Postal Code',      notionKey: 'property_postal_code' },
  country:          { prop: 'Country',          notionKey: 'property_country' },
  phone:            { prop: 'Phone',            notionKey: 'property_phone' },
};

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
    returnAll: false,
    limit: 1,
    filterType: 'manual',
    matchType: 'anyFilter',
    filters: {
      conditions: [
        {
          key: 'Identifier|title',
          condition: 'equals',
          titleValue: '={{ $json.email }}',
        },
      ],
    },
  },
  { position: [750, 300], typeVersion: 2.2 },
);

// Ensure the IF node runs even when the lookup returns zero results.
lookup.settings = { alwaysOutputData: true };

// Branch: does a matching contact already exist?
const ifExists = createNode(
  'Contact Exists?',
  'n8n-nodes-base.if',
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
          leftValue: '={{ $json.id }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'exists',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1000, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// True branch – pair incoming data with Notion record, merge, then update
// ---------------------------------------------------------------------------

// The Merge node combines the Notion lookup result (input 0, from IF TRUE)
// with the original incoming data (input 1, from Has Email?) by position.
// This gives the Code node a single item containing BOTH sets of fields:
//   - Notion fields:   id, name, property_email, property_first_name, …
//   - Incoming fields:  email, first_name, last_name, …
// No $('NodeName') back-references needed.
const pairRecords = createNode(
  'Pair Records',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {
      clashHandling: {
        values: {
          resolveClash: 'preferLast',
          mergeMode: 'shallowMerge',
          overrideEmpty: false,
        },
      },
    },
  },
  { position: [1200, 150], typeVersion: 3 },
);

const MERGE_CODE = `
/**
 * Returns true when a value carries meaningful data (i.e. is not null,
 * undefined, empty string, or empty array).
 */
function hasValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

/**
 * Returns true when two values are effectively equal.
 * Treats null, undefined, and empty string as equivalent ("no value").
 * Compares arrays by JSON serialisation (handles tags).
 */
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

// Field mapping:
//   incoming key → { prop: Notion property name (for output), notionKey: simplified output field }
// Notion v2.2 simplified output uses "property_" + snake_case, e.g. "First name" → "property_first_name"
const fieldMap = ${JSON.stringify(FIELD_MAP, null, 2)};

// Each input item already contains BOTH the Notion record fields (property_xxx)
// and the incoming contact fields (email, first_name, etc.) — merged by the
// upstream "Pair Records" node.
const results = [];
for (const item of $input.all()) {
  const data = item.json;

  const merged = {
    pageId: data.id,
    Identifier: data.email,
  };

  // For every mapped field, prefer the incoming value when it has data;
  // otherwise keep the existing Notion value.
  // Track whether any field actually changed from the stored value.
  let changed = false;
  for (const [inKey, mapping] of Object.entries(fieldMap)) {
    const newVal = data[inKey];              // incoming value
    const oldVal = data[mapping.notionKey];  // existing Notion value
    const mergedVal = hasValue(newVal) ? newVal : (oldVal ?? null);
    merged[mapping.prop] = mergedVal;

    if (!valuesEqual(mergedVal, oldVal)) changed = true;
  }

  // Only emit records that have at least one changed field —
  // skip the Notion update when every value is already up-to-date.
  if (changed) results.push({ json: merged });
}

return results;
`.trim();

const merge = createNode(
  'Merge Records',
  'n8n-nodes-base.code',
  {
    jsCode: MERGE_CODE,
    mode: 'runOnceForAllItems',
  },
  { position: [1450, 150], typeVersion: 2 },
);

const update = createNode(
  'Update Contact',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      mode: 'id',
      value: '={{ $json.pageId }}',
    },
    propertiesUi: {
      propertyValues: [
        { key: 'Identifier|title',            title:         '={{ $json.Identifier }}' },
        { key: 'Email|email',                 emailValue:    '={{ $json.Email }}' },
        { key: 'First name|rich_text',        richText: false, textContent: '={{ $json["First name"] }}' },
        { key: 'Last name|rich_text',         richText: false, textContent: '={{ $json["Last name"] }}' },
        { key: 'Company Name|rich_text',      richText: false, textContent: '={{ $json["Company Name"] }}' },
        { key: 'Email Marketing|select',       selectValue: '={{ $json["Email Marketing"] }}' },
        { key: 'Tags|multi_select',           multiSelectValue: '={{ ($json.Tags || []).join(", ") }}' },
        { key: 'Street Address|rich_text',    richText: false, textContent: '={{ $json["Street Address"] }}' },
        { key: 'Address Line 2|rich_text',    richText: false, textContent: '={{ $json["Address Line 2"] }}' },
        { key: 'City|rich_text',              richText: false, textContent: '={{ $json.City }}' },
        { key: 'State|rich_text',             richText: false, textContent: '={{ $json.State }}' },
        { key: 'Postal Code|rich_text',       richText: false, textContent: '={{ $json["Postal Code"] }}' },
        { key: 'Country|rich_text',           richText: false, textContent: '={{ $json.Country }}' },
        { key: 'Phone|phone_number',          phoneValue:    '={{ $json.Phone }}' },
      ],
    },
  },
  { position: [1700, 150], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// False branch – create a brand-new contact
// ---------------------------------------------------------------------------

// Helper: expression that references a field on the trigger output
const src = (field) => `={{ $('Receive Contact').first().json.${field} }}`;

const create = createNode(
  'Create Contact',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'create',
    databaseId: {
      __rl: true,
      mode: 'id',
      value: DATABASE_ID,
    },
    title: src('email'),
    propertiesUi: {
      propertyValues: [
        { key: 'Email|email',                 emailValue:    src('email') },
        { key: 'First name|rich_text',        richText: false, textContent: src('first_name') },
        { key: 'Last name|rich_text',         richText: false, textContent: src('last_name') },
        { key: 'Company Name|rich_text',      richText: false, textContent: src('company') },
        { key: 'Email Marketing|select',       selectValue: src('email_marketing') },
        { key: 'Tags|multi_select',           multiSelectValue: `={{ ($('Receive Contact').first().json.tags || []).join(', ') }}` },
        { key: 'Street Address|rich_text',    richText: false, textContent: src('street_address') },
        { key: 'Address Line 2|rich_text',    richText: false, textContent: src('street_address_2') },
        { key: 'City|rich_text',              richText: false, textContent: src('city') },
        { key: 'State|rich_text',             richText: false, textContent: src('state') },
        { key: 'Postal Code|rich_text',       richText: false, textContent: src('postal_code') },
        { key: 'Country|rich_text',           richText: false, textContent: src('country') },
        { key: 'Phone|phone_number',          phoneValue:    src('phone') },
      ],
    },
  },
  { position: [1250, 450], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Master Contact Upsert', {
  nodes: [trigger, hasEmail, lookup, ifExists, pairRecords, merge, update, create],
  connections: [
    connect(trigger, hasEmail),
    connect(hasEmail, lookup),              // passes through only if email is present
    connect(hasEmail, pairRecords, 0, 1),   // also send original data → Pair Records input 1
    connect(lookup, ifExists),
    connect(ifExists, pairRecords, 0, 0),   // true  → Pair Records input 0 (Notion data)
    connect(pairRecords, merge),             // paired data → Code node
    connect(merge, update),
    connect(ifExists, create, 1, 0),         // false → create
  ],
  tags: ['sub-workflow', 'contacts'],
});
