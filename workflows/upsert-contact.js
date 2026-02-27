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
 *   5. If found → merge (prefer non-null incoming values) → update
 *   6. If not found → create new record
 *
 * After import into n8n:
 *   - Connect the Notion credential on each Notion node
 *   - Verify the database is selected and property mappings look correct
 *   - Enable "Always Output Data" on the Lookup Contact node (Settings tab)
 *     so the Merge node always receives data on both inputs
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
  { position: [750, 200], typeVersion: 2.2 },
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
// True branch – merge incoming + existing values, then update
// ---------------------------------------------------------------------------

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

// Each input item has:
//   - data.incoming  = original incoming contact fields
//   - data.notion    = Notion lookup result (with property_xxx fields)
//   - data.Identifier = the email used for matching
const results = [];
for (const item of $input.all()) {
  const data = item.json;

  const merged = {
    pageId: data.notion.id,
    Identifier: data.Identifier,
  };

  // For every mapped field, prefer the incoming value when it has data;
  // otherwise keep the existing Notion value.
  // Track whether any field actually changed from the stored value.
  let changed = false;
  for (const [inKey, mapping] of Object.entries(fieldMap)) {
    const newVal = data.incoming[inKey];              // incoming value
    const oldVal = data.notion[mapping.notionKey];    // existing Notion value
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
  { position: [1550, 200], typeVersion: 2 },
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
    options: {},
  },
  { position: [1750, 200], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// False branch – create a brand-new contact
// ---------------------------------------------------------------------------

// Replace null incoming values with empty strings/arrays before passing
// them to the Notion Create node, to avoid Notion API errors.
const REMOVE_NULLS_CODE = `
let textFields = [
  "email", "first_name", "last_name", "company",
  "street_address", "street_address_2", "city", "state", "postal_code",
  "country", "phone", "email_marketing"
];
let arrayFields = ["tags"];

for (const field of textFields) {
  if ($input.item.json.incoming[field] == null) {
    $input.item.json.incoming[field] = "";
  }
}
for (const field of arrayFields) {
  if ($input.item.json.incoming[field] == null) {
    $input.item.json.incoming[field] = [];
  }
}
return $input.item;
`.trim();

const removeNulls = createNode(
  'Remove Nulls',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: REMOVE_NULLS_CODE,
  },
  { position: [1550, 400], typeVersion: 2 },
);

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
    title: '={{ $json.Identifier }}',
    propertiesUi: {
      propertyValues: [
        { key: 'Email|email',                 emailValue:    '={{ $json.incoming.email }}' },
        { key: 'First name|rich_text',        richText: false, textContent: '={{ $json.incoming.first_name || "" }}' },
        { key: 'Last name|rich_text',         richText: false, textContent: '={{ $json.incoming.last_name || "" }}' },
        { key: 'Company Name|rich_text',      richText: false, textContent: '={{ $json.incoming.company || "" }}' },
        { key: 'Email Marketing|select',       selectValue: '={{ $json.incoming.email_marketing || "" }}' },
        { key: 'Tags|multi_select',           multiSelectValue: '={{ ($json.incoming.tags || []).join(", ") }}' },
        { key: 'Street Address|rich_text',    richText: false, textContent: '={{ $json.incoming.street_address || "" }}' },
        { key: 'Address Line 2|rich_text',    richText: false, textContent: '={{ $json.incoming.street_address_2 || "" }}' },
        { key: 'City|rich_text',              richText: false, textContent: '={{ $json.incoming.city || "" }}' },
        { key: 'State|rich_text',             richText: false, textContent: '={{ $json.incoming.state || "" }}' },
        { key: 'Postal Code|rich_text',       richText: false, textContent: '={{ $json.incoming.postal_code || "" }}' },
        { key: 'Country|rich_text',           richText: false, textContent: '={{ $json.incoming.country || "" }}' },
        { key: 'Phone|phone_number',          phoneValue:    '={{ $json.incoming.phone || "" }}' },
      ],
    },
    options: {},
  },
  { position: [1750, 400], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Master Contact Upsert', {
  nodes: [
    trigger, hasEmail, lookup, markExisting, markInbound,
    pairRecords, ifExists, merge, update, removeNulls, create,
  ],
  connections: [
    connect(trigger, hasEmail),
    connect(hasEmail, lookup),              // passes through only if email is present
    connect(hasEmail, markInbound),         // also wrap original data as { incoming, Identifier }
    connect(lookup, markExisting),          // wrap Notion result as { notion, Identifier }
    connect(markExisting, pairRecords, 0, 0),  // Notion data → Pair Records input 0
    connect(markInbound, pairRecords, 0, 1),   // incoming data → Pair Records input 1
    connect(pairRecords, ifExists),            // paired data → IF
    connect(ifExists, merge, 0, 0),            // true  → Merge Records Code
    connect(merge, update),
    connect(ifExists, removeNulls, 1, 0),      // false → Remove Nulls
    connect(removeNulls, create),              // cleaned data → Create Contact
  ],
  tags: ['sub-workflow', 'contacts'],
});
