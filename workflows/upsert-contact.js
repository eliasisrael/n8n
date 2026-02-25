/**
 * Sub-workflow: Upsert Contact
 *
 * Called by other workflows to add or update a contact in the master
 * Notion contacts database.
 *
 * Input (from calling workflow):
 *   { email, first_name, last_name, company, email_marketing, tags,
 *     street_address, street_address_2, city, state, postal_code,
 *     country, phone, birthday }
 *
 * Logic:
 *   1. Look up existing contact by Identifier (email) in Notion
 *   2. If found → merge (prefer non-null incoming values) → update
 *   3. If not found → create new record
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
const DATABASE_ID = '1688ebaf15ee80f99cc3d65aa82fdbc1';

// Map from incoming field names → Notion property names
const FIELD_MAP = {
  email:            'Email',
  first_name:       'First name',
  last_name:        'Last name',
  company:          'Company name',
  email_marketing:  'Email marketing',
  tags:             'Tags',
  street_address:   'Street Address',
  street_address_2: 'Address Line 2',
  city:             'City',
  state:            'State',
  postal_code:      'Postal Code',
  country:          'Country',
  phone:            'Phone',
  birthday:         'Birthday',
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'Receive Contact',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'defineBelow',
    workflowInputs: {
      values: [
        { name: 'email',            type: 'string' },
        { name: 'first_name',       type: 'string' },
        { name: 'last_name',        type: 'string' },
        { name: 'company',          type: 'string' },
        { name: 'email_marketing',  type: 'string' },
        { name: 'tags',             type: 'json'   },
        { name: 'street_address',   type: 'string' },
        { name: 'street_address_2', type: 'string' },
        { name: 'city',             type: 'string' },
        { name: 'state',            type: 'string' },
        { name: 'postal_code',      type: 'string' },
        { name: 'country',          type: 'string' },
        { name: 'phone',            type: 'string' },
        { name: 'birthday',         type: 'string' },
      ],
    },
  },
  { position: [250, 300] },
);

// Query Notion for an existing contact whose Identifier matches the email.
const lookup = createNode(
  'Lookup Contact',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: DATABASE_ID,
    returnAll: false,
    limit: 1,
    filterType: 'formula',
    filters: {
      conditions: [
        {
          key: 'Identifier|title',
          condition: 'equals',
          returnType: 'string',
          value: '={{ $json.email }}',
        },
      ],
      combinator: 'and',
    },
  },
  { position: [500, 300], typeVersion: 2.2 },
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
  { position: [750, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// True branch – merge incoming data with existing record, then update
// ---------------------------------------------------------------------------

const MERGE_CODE = `
// Incoming contact from the calling workflow
const incoming = $('Receive Contact').first().json;
// Existing Notion record (simplified output — properties are top-level keys)
const existing = $input.first().json;

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

// Field mapping: incoming key → Notion property name
const fieldMap = ${JSON.stringify(FIELD_MAP, null, 2)};

// Start with the page ID and the title (Identifier = email)
const merged = {
  pageId: existing.id,
  Identifier: incoming.email,
};

// For every mapped field, prefer the incoming value when it has data;
// otherwise keep the existing value from Notion.
for (const [inKey, notionProp] of Object.entries(fieldMap)) {
  const newVal = incoming[inKey];
  const oldVal = existing[notionProp];
  merged[notionProp] = hasValue(newVal) ? newVal : (oldVal ?? null);
}

return [{ json: merged }];
`.trim();

const merge = createNode(
  'Merge Records',
  'n8n-nodes-base.code',
  {
    jsCode: MERGE_CODE,
    mode: 'runOnceForAllItems',
  },
  { position: [1000, 150], typeVersion: 2 },
);

const update = createNode(
  'Update Contact',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'update',
    pageId: '={{ $json.pageId }}',
    propertiesUi: {
      propertyValues: [
        { key: 'Identifier|title',            title:         '={{ $json.Identifier }}' },
        { key: 'Email|email',                 emailValue:    '={{ $json.Email }}' },
        { key: 'First name|rich_text',        richTextValue: '={{ $json["First name"] }}' },
        { key: 'Last name|rich_text',         richTextValue: '={{ $json["Last name"] }}' },
        { key: 'Company name|rich_text',      richTextValue: '={{ $json["Company name"] }}' },
        { key: 'Email marketing|rich_text',   richTextValue: '={{ $json["Email marketing"] }}' },
        { key: 'Tags|multi_select',           multiSelectValue: '={{ ($json.Tags || []).join(", ") }}' },
        { key: 'Street Address|rich_text',    richTextValue: '={{ $json["Street Address"] }}' },
        { key: 'Address Line 2|rich_text',    richTextValue: '={{ $json["Address Line 2"] }}' },
        { key: 'City|rich_text',              richTextValue: '={{ $json.City }}' },
        { key: 'State|rich_text',             richTextValue: '={{ $json.State }}' },
        { key: 'Postal Code|rich_text',       richTextValue: '={{ $json["Postal Code"] }}' },
        { key: 'Country|rich_text',           richTextValue: '={{ $json.Country }}' },
        { key: 'Phone|phone_number',          phoneValue:    '={{ $json.Phone }}' },
        { key: 'Birthday|date',               date:          '={{ $json.Birthday }}', includeTime: false },
      ],
    },
  },
  { position: [1250, 150], typeVersion: 2.2 },
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
    databaseId: DATABASE_ID,
    title: src('email'),
    propertiesUi: {
      propertyValues: [
        { key: 'Email|email',                 emailValue:    src('email') },
        { key: 'First name|rich_text',        richTextValue: src('first_name') },
        { key: 'Last name|rich_text',         richTextValue: src('last_name') },
        { key: 'Company name|rich_text',      richTextValue: src('company') },
        { key: 'Email marketing|rich_text',   richTextValue: src('email_marketing') },
        { key: 'Tags|multi_select',           multiSelectValue: `={{ ($('Receive Contact').first().json.tags || []).join(', ') }}` },
        { key: 'Street Address|rich_text',    richTextValue: src('street_address') },
        { key: 'Address Line 2|rich_text',    richTextValue: src('street_address_2') },
        { key: 'City|rich_text',              richTextValue: src('city') },
        { key: 'State|rich_text',             richTextValue: src('state') },
        { key: 'Postal Code|rich_text',       richTextValue: src('postal_code') },
        { key: 'Country|rich_text',           richTextValue: src('country') },
        { key: 'Phone|phone_number',          phoneValue:    src('phone') },
        { key: 'Birthday|date',               date:          src('birthday'), includeTime: false },
      ],
    },
  },
  { position: [1000, 450], typeVersion: 2.2 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Master Contact Upsert', {
  nodes: [trigger, lookup, ifExists, merge, update, create],
  connections: [
    connect(trigger, lookup),
    connect(lookup, ifExists),
    connect(ifExists, merge, 0, 0),   // true  → merge & update
    connect(merge, update),
    connect(ifExists, create, 1, 0),  // false → create
  ],
  tags: ['sub-workflow', 'contacts'],
});
