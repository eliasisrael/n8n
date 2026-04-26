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
 *      API request body. Has Update? gate: if any field actually changes,
 *      HTTP PATCH; otherwise skip the PATCH and forward the existing page
 *      directly to Return Contact (preserving N-in-N-out).
 *   6. If not found → build Notion API request body (only non-null
 *      properties) → HTTP POST to create
 *   7. Return Contact: single terminal that emits the upserted page record
 *      ({ id, page_id, email, properties, notion }) per inbound contact.
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

// Upstash Redis for loop detection
function stripQuotes(s) {
  if (s && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
const UPSTASH_URL = stripQuotes(process.env.UPSTASH_REDIS_REST_URL) || '';
const UPSTASH_CREDENTIAL = { httpHeaderAuth: { id: 'mxEZyivdASDcGG7S', name: 'Upstash Redis (Fulcrum)' } };

// Pushover for loop alerts
const PUSHOVER_CREDENTIAL = {
  pushoverApi: { id: '8yRL2WE5w6WO2crY', name: 'Pushover account' },
};
const PUSHOVER_USER_KEY = 'u8cx9933n6kq69g1uotjavhxcwri7n';

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
  mailchimp_profile:{ prop: 'Mailchimp Profile', notionKey: 'property_mailchimp_profile', apiType: 'url' },
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
    case 'url':          return { url: String(value) };
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
  { position: [256, 496], typeVersion: 1.1 },
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
  { position: [480, 496], typeVersion: 2 },
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
  { position: [704, 400], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);

// Ensure the Merge node always receives data on input 0, even when all
// lookups return zero results.
lookup.settings = { alwaysOutputData: true };
lookup.alwaysOutputData = true;
lookup.retryOnFail = true;
lookup.maxTries = 3;
lookup.waitBetweenTries = 1000;

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
  { position: [928, 400], typeVersion: 3.4 },
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
  { position: [928, 592], typeVersion: 3.4 },
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
  { position: [1152, 496], typeVersion: 3 },
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
  { position: [1376, 496], typeVersion: 2 },
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
    const setB = new Set(b);
    return a.length === b.length && a.every(v => setB.has(v));
  }
  return a === b;
}

// For multi_select: incoming is "no change needed" if it is a subset of existing
function isSubset(incoming, existing) {
  if (!Array.isArray(incoming) || !Array.isArray(existing)) return false;
  const existingSet = new Set(existing);
  return incoming.every(v => existingSet.has(v));
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

    // For multi_select (e.g. Tags): if incoming is a subset of existing,
    // keep existing as-is (no change). Otherwise union the arrays.
    let mergedVal;
    if (mapping.apiType === 'multi_select') {
      if (Array.isArray(newVal) && Array.isArray(oldVal) && isSubset(newVal, oldVal)) {
        mergedVal = oldVal; // incoming adds nothing new — no change needed
      } else if (Array.isArray(newVal) && Array.isArray(oldVal)) {
        mergedVal = [...new Set([...oldVal, ...newVal])];
      } else {
        mergedVal = hasValue(newVal) ? newVal : (oldVal ?? null);
      }
    } else {
      mergedVal = hasValue(newVal) ? newVal : (oldVal ?? null);
    }

    if (!valuesEqual(mergedVal, oldVal)) changed = true;

    // Only include non-null properties in the API request body
    if (hasValue(mergedVal)) {
      properties[mapping.prop] = toNotionProp(mapping.apiType, mergedVal);
    }
  }

  if (changed) {
    results.push({
      json: {
        _has_update: true,
        pageId: data.notion.id,
        requestBody: JSON.stringify({ properties }),
        _email: data.Identifier,
      },
    });
  } else {
    // No fields differ from what Notion already has — skip the HTTP PATCH but
    // still emit a page-shaped item so the contact flows through to Return
    // Contact (the sub-workflow's contract is "N inbound = N outbound").
    results.push({
      json: {
        _has_update: false,
        object: 'page',
        id: data.notion.id,
        properties: {
          Identifier: {
            title: [{
              type: 'text',
              text: { content: data.Identifier },
              plain_text: data.Identifier,
            }],
          },
        },
        _email: data.Identifier,
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
  { position: [1600, 328], typeVersion: 2 },
);

// IF gate: only changed records hit the Notion PATCH; unchanged records skip
// to Return Contact directly (still emitted so the sub-workflow's "N in =
// N out" contract holds).
const hasUpdate = createNode(
  'Has Update?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json._has_update }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2272, 280], typeVersion: 2.2 },
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
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [2496, 208], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
update.retryOnFail = true;
update.maxTries = 3;
update.waitBetweenTries = 1000;

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
      _email: data.Identifier,
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
  { position: [1600, 736], typeVersion: 2 },
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
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [2496, 784], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
create.retryOnFail = true;
create.maxTries = 3;
create.waitBetweenTries = 1000;

// ---------------------------------------------------------------------------
// Loop detection — Redis INCR with fixed 5-minute window
//
// Runs in parallel with the actual Notion write (Update / Create). If the
// same email is upserted 4+ times within a 5-minute window, fires a
// Pushover alert. Failures on this path never affect the main upsert.
// ---------------------------------------------------------------------------

const PREPARE_LOOP_CHECK_CODE = `
const results = [];
for (const item of $input.all()) {
  const email = (item.json._email || '').toLowerCase().trim();
  if (!email) continue;

  const luaScript = "local count = redis.call('INCR', KEYS[1])\\nif count == 1 then\\nredis.call('EXPIRE', KEYS[1], ARGV[1])\\nend\\nreturn count";
  const redisBody = JSON.stringify(["EVAL", luaScript, "1", "loop:" + email, "300"]);

  results.push({ json: { email, redisBody } });
}
return results;
`.trim();

const prepareLoopCheck = createNode(
  'Prepare Loop Check',
  'n8n-nodes-base.code',
  {
    jsCode: PREPARE_LOOP_CHECK_CODE,
    mode: 'runOnceForAllItems',
  },
  { position: [1824, 568], typeVersion: 2 },
);

const loopIncr = createNode(
  'Loop INCR',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: UPSTASH_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.redisBody }}',
    options: {},
  },
  { position: [2048, 568], typeVersion: 4.2, credentials: UPSTASH_CREDENTIAL },
);
loopIncr.onError = 'continueRegularOutput';

// IF (not Filter) so we have an explicit false-branch output (output 1) that
// can flow into Return Contact alongside the rest, making Return Contact the
// sole terminal of the sub-workflow.
const loopThreshold = createNode(
  'Loop Threshold',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.result >= 4 }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2272, 568], typeVersion: 2.2 },
);

const loopAlert = createNode(
  'Loop Alert',
  'n8n-nodes-base.pushover',
  {
    userKey: PUSHOVER_USER_KEY,
    message: '=LOOP DETECTED: Contact {{ $("Prepare Loop Check").item.json.email }} modified {{ $json.result }} times in 5-minute window. Possible Notion/Mailchimp oscillation.',
    priority: 1,
    additionalFields: {},
  },
  {
    typeVersion: 1,
    // Hand-adjusted on the server. Sits above mergeContacts (y=448) to
    // satisfy "output 0 above output 1" for loopThreshold:
    //   output 0 (true) → loopAlert (y=496, ABOVE-ish — actually slightly
    //                                  below merge but on its own column)
    //   output 1 (false) → mergeContacts (y=448)
    position: [2496, 496],
    credentials: PUSHOVER_CREDENTIAL,
  },
);

// ---------------------------------------------------------------------------
// Merge All Outputs — explicit synchronization point
//
// Merge node (append mode, 5 typed inputs) waits for every upstream branch
// to reach a "done" state before emitting. Unlike a Code node with multiple
// fan-ins on input 0 — which relies on n8n's implicit v1-execution-order
// semantics — a Merge node has explicit per-input ports that the engine
// synchronizes on. Future n8n behavior changes can't silently de-sync the
// branches.
//
// Inputs (0-indexed):
//   0 — Update Contact   (HTTP PATCH response, Notion page)
//   1 — Has Update?      (false branch — page-shaped pass-through, no PATCH)
//   2 — Create Contact   (HTTP POST response, Notion page)
//   3 — Loop Threshold   (false branch — Redis INCR response, no loop)
//   4 — Loop Alert       (Pushover response, loop detected and alerted)
// ---------------------------------------------------------------------------

const mergeContacts = createNode(
  'Merge All Outputs',
  'n8n-nodes-base.merge',
  {
    mode: 'append',
    numberInputs: 5,
    options: {},
  },
  { position: [2720, 448], typeVersion: 3 },
);

// ---------------------------------------------------------------------------
// Return Contact — single terminal node
//
// For each upserted contact (update or create or no-op), emits exactly one
// record on the output. Side-channel responses from the loop-detection
// chain (Redis INCR, Pushover) are filtered out by the object === 'page'
// check.
//
// Multi-item correctness:
//   - The sub-workflow can receive N inbound records and must return N
//     records on output (one per upserted contact, paired back to the
//     correct input via pairedItem).
//   - Update Contact emits one Notion page per update; Has Update? false
//     branch emits one page-shaped item per unchanged record; Create
//     Contact emits one Notion page per create. Together these account
//     for every record that passed the Has Email? filter.
//   - The loop chain emits Redis/Pushover responses through the same Merge
//     synchronization point — we drop them by checking object === 'page'.
//
// Output shape per item:
//   { id, page_id, email, properties, notion: <full page response> }
// ---------------------------------------------------------------------------

const RETURN_CONTACT_CODE = `
const results = [];
for (const item of $input.all()) {
  const json = item.json;
  // Drop side-channel outputs from the loop-detection chain.
  if (!json || json.object !== 'page' || !json.id) continue;

  const titleProp = json.properties?.Identifier?.title?.[0];
  const email = titleProp?.plain_text || titleProp?.text?.content || null;

  results.push({
    json: {
      id: json.id,
      page_id: json.id,
      email,
      properties: json.properties,
      notion: json,
    },
    pairedItem: item.pairedItem,
  });
}
return results;
`.trim();

const returnContact = createNode(
  'Return Contact',
  'n8n-nodes-base.code',
  { jsCode: RETURN_CONTACT_CODE, mode: 'runOnceForAllItems' },
  { position: [2944, 496], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Notion Master Contact Upsert', {
  nodes: [
    trigger, hasEmail, lookup, markExisting, markInbound,
    pairRecords, ifExists, buildUpdateBody, hasUpdate, update, buildCreateBody, create,
    prepareLoopCheck, loopIncr, loopThreshold, loopAlert,
    mergeContacts, returnContact,
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
    connect(buildUpdateBody, hasUpdate),       // gate: skip PATCH if nothing changed
    connect(hasUpdate, update, 0, 0),          // _has_update = true → HTTP PATCH
    connect(ifExists, buildCreateBody, 1, 0),  // false → Build Create Body
    connect(buildCreateBody, create),          // → Create Contact (HTTP POST)

    // Loop detection (parallel to write — failures here never affect the upsert)
    connect(buildUpdateBody, prepareLoopCheck),   // updates count toward loop
    connect(buildCreateBody, prepareLoopCheck),   // creates count toward loop
    connect(prepareLoopCheck, loopIncr),
    connect(loopIncr, loopThreshold),
    connect(loopThreshold, loopAlert, 0, 0),       // true (>= 4 events) → Pushover alert

    // All five output paths funnel into Merge All Outputs, which explicitly
    // waits for every input port to reach a "done" state before emitting.
    // Return Contact then filters to keep only the Notion page records.
    //
    // Input order matches the vertical position of source nodes on the
    // canvas (top→bottom) so the convergence arcs don't cross:
    //   0 — Update Contact   (y=208, top)
    //   1 — Has Update? false (y=280)
    //   2 — Loop Alert       (y=496)
    //   3 — Loop Threshold false (y=568)
    //   4 — Create Contact   (y=784, bottom)
    connect(update,         mergeContacts, 0, 0),  // PATCH response (changed records)
    connect(hasUpdate,      mergeContacts, 1, 1),  // skip-PATCH branch (unchanged records)
    connect(loopAlert,      mergeContacts, 0, 2),  // alert sent
    connect(loopThreshold,  mergeContacts, 1, 3),  // no loop detected
    connect(create,         mergeContacts, 0, 4),  // POST response (new records)
    connect(mergeContacts,  returnContact),
  ],
  tags: ['sub-workflow', 'contacts'],
});
