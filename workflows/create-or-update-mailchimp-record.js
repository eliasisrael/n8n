/**
 * Create or Update Mailchimp Record
 *
 * Sub-workflow called by the Contacts adapter (via "Contact Updates from
 * Notion") to sync a contact to Mailchimp. Includes the NOTIONID guard
 * that prevents stale/duplicate Notion records from overwriting Mailchimp
 * data after a merge-duplicate operation.
 *
 * NOTIONID Guard Logic:
 *   - Incoming page ID matches Mailchimp NOTIONID → update (authorized)
 *   - Mailchimp NOTIONID is blank → update + claim (write page ID)
 *   - Incoming page ID doesn't match → SKIP (stale/duplicate)
 *   - No page ID provided (non-Notion caller) → bypass guard entirely
 *
 * Flow:
 *   Trigger → Enforce Required Format → Validate Email
 *     ├─[OK] Email Valid? (mx + spam) → Find Existing Subs
 *     └─[Error] Service Down? → true (5xx): bypass to Find Existing Subs
 *                              → false (4xx): drop (invalid email)
 *   Find Existing Subs → Validate Lookup → Enforce Email
 *   Lowercase → NOTIONID Guard → Guard Filter → Switch
 *     ├─[Update — merge fields] Filter Merge Fields Changed → Remove Cleaned
 *     │    → Build Update Record → Update Subscribers
 *     │       └→ If Claiming → Build Writeback URL → Write URL to Notion
 *     ├─[Update — tags] Filter Tags Changed → Build Tags → Record Tags
 *     └─[Create] Insert New Subs
 *                └→ If Claiming (New) → Build Writeback URL (New) → Write URL to Notion (New)
 *
 * Replaces: server/create-or-update-mailchimp-record.json (ID: qvhhwm0l47pZnP8c)
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAILCHIMP_LIST_ID = '77d135987f';
const MAILCHIMP_CREDENTIAL = {
  mailchimpOAuth2Api: { id: 'DtyHZOOulvefkbC3', name: 'Mailchimp account' },
};
const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Execute Workflow Trigger — entry point when called by another workflow
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'jsonExample',
    jsonExample: JSON.stringify({
      email_address: 'eli@eliasisrael.com',
      full_name: '',
      status: 'subscribed',
      FNAME: '',
      LNAME: '',
      ADDRESS: '',
      PHONE: '',
      BIRTHDAY: '',
      COMPANY: '',
      Tags: [],
      id: '',
      notion_page_id: '',
    }),
  },
  { position: [160, -336], typeVersion: 1.1 },
);

// 2. Enforce Required Format — lowercase email, default status, extract page ID
const enforceFormat = createNode(
  'Enforce Required Format',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'status',
          value: '={{ ($json.status || "subscribed").toLowerCase() }}',
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'email_address',
          value: '={{ $json.email_address.toLowerCase() }}',
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'notion_page_id',
          value: '={{ $json.id || $json.notion_page_id || "" }}',
          type: 'string',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  { position: [384, -336], typeVersion: 3.4 },
);

// 2b. Validate Email — call UserCheck to verify syntax, MX, and spam status.
//     Returns 400 for invalid syntax, 200 with mx/spam fields for valid domains.
//     Error output (output 1) catches both 400s and service outages.
const validateEmail = createNode(
  'Validate Email',
  'n8n-nodes-base.httpRequest',
  {
    url: '=https://api.usercheck.com/email/{{ encodeURI($json.email_address) }}',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendQuery: true,
    queryParameters: { parameters: [{}] },
    options: {},
  },
  {
    position: [608, -336],
    typeVersion: 4.2,
    credentials: { httpHeaderAuth: { id: 'sGklpGDze5oWu3MF', name: 'UserCheck API' } },
  },
);
validateEmail.retryOnFail = true;
validateEmail.onError = 'continueErrorOutput';

// 2c. Email Valid? — require MX record exists and not flagged as spam.
const emailValid = createNode(
  'Email Valid?',
  'n8n-nodes-base.filter',
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
          leftValue: '={{ $json.mx }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.spam }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'false', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [832, -336], typeVersion: 2.2 },
);

// 2d. Service Down? — distinguish 400 (bad email, drop) from 5xx (outage, bypass).
//     On the error output from Validate Email, check the status code. If it's a
//     client error (4xx), the email itself is invalid — stop. If it's a server
//     error or network failure, let the contact through so a UserCheck outage
//     doesn't block processing.
const serviceDown = createNode(
  'Service Down?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'loose',
        version: 2,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.statusCode || 500 }}',
          rightValue: '500',
          operator: { type: 'number', operation: 'gte' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [832, -144], typeVersion: 2.2 },
);

// 3. Find Existing Subs — Mailchimp GET by email
//    onError: continueRegularOutput handles 404 for new subscribers
const findExisting = createNode(
  'Find Existing Subs',
  'n8n-nodes-base.mailchimp',
  {
    authentication: 'oAuth2',
    operation: 'get',
    list: MAILCHIMP_LIST_ID,
    email: "={{ $('Enforce Required Format').item.json.email_address }}",
    options: {},
  },
  { position: [1056, -336], typeVersion: 1, credentials: MAILCHIMP_CREDENTIAL },
);
findExisting.retryOnFail = true;
findExisting.maxTries = 3;
findExisting.waitBetweenTries = 2000;
findExisting.onError = 'continueRegularOutput';

// 3b. Validate Lookup — distinguish "not found" (no id) from API errors
//     A successful lookup has an `id` field. A 404 also passes through with
//     no `id` but no `error` either. An API failure has `error` as a string.
const validateLookup = createNode(
  'Validate Lookup',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const j = $input.item.json;

// Successful lookup — Mailchimp member found
if (j.id) return $input.item;

// Error response from Mailchimp — distinguish "not found" from real errors
if (typeof j.error === 'string' && j.error.length > 0) {
  const msg = j.error.toLowerCase();
  // 404: "The resource you are requesting could not be found"
  if (msg.includes('could not be found') || msg.includes('not found')) {
    return $input.item; // subscriber doesn't exist — pass through to Create
  }
  // Any other error (service unavailable, rate limit, etc.) — stop execution
  throw new Error('Mailchimp API error: ' + j.error);
}

// No id and no error — pass through to Create branch
return $input.item;`,
  },
  { position: [1280, -336], typeVersion: 2 },
);

// 4. Enforce Email Lowercase — normalize the lookup result email
const enforceEmailLower = createNode(
  'Enforce Email Lowercase',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'email_address',
          value: '={{ $json.email_address.toLowerCase() }}',
          type: 'string',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  { position: [1504, -336], typeVersion: 3.4 },
);

// 5. NOTIONID Guard — Code node that compares incoming page ID with Mailchimp NOTIONID
const notionIdGuard = createNode(
  'NOTIONID Guard',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const notionId = ($json.merge_fields && $json.merge_fields.NOTIONID) || '';
const incomingId = $('Enforce Required Format').item.json.notion_page_id || '';

if (!incomingId) {
  // Non-Notion caller — bypass guard
  $input.item.json.guard_action = 'proceed';
  $input.item.json.should_claim = false;
} else if (!notionId || notionId === incomingId) {
  // Blank (claim) or match (authorized) — proceed
  $input.item.json.guard_action = 'proceed';
  $input.item.json.should_claim = !notionId;
} else {
  // Mismatch — stale/duplicate source, skip
  $input.item.json.guard_action = 'skip';
  $input.item.json.should_claim = false;
}

return $input.item;`,
  },
  { position: [1728, -336], typeVersion: 2 },
);

// 6. Guard Filter — drop items where guard says skip
const guardFilter = createNode(
  'Guard Filter',
  'n8n-nodes-base.filter',
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
          leftValue: '={{ $json.guard_action }}',
          rightValue: 'proceed',
          operator: {
            type: 'string',
            operation: 'equals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1952, -336], typeVersion: 2.2 },
);

// 7. Switch — existing member (Update) vs new member (Create)
const switchNode = createNode(
  'Switch',
  'n8n-nodes-base.switch',
  {
    rules: {
      values: [
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
                leftValue: '={{ $json.id }}',
                rightValue: 'abc',
                operator: {
                  type: 'string',
                  operation: 'exists',
                  singleValue: true,
                },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Update',
        },
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
                leftValue: '={{ $json.id }}',
                rightValue: '',
                operator: {
                  type: 'string',
                  operation: 'notExists',
                  singleValue: true,
                },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Create',
        },
      ],
    },
    options: {},
  },
  { position: [2176, -336], typeVersion: 3.2 },
);

// ---------------------------------------------------------------------------
// Update branch — three independent paths from Switch to avoid unnecessary
// Mailchimp API calls (each call triggers the Audience webhook)
// ---------------------------------------------------------------------------

// 8a. Filter: Merge Fields Changed — only call Update Subscribers when
//     FNAME/LNAME/COMPANY/full_name actually differ, or NOTIONID needs claiming
const filterMergeFields = createNode(
  'Filter Merge Fields Changed',
  'n8n-nodes-base.filter',
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
          leftValue: '={{ $json.full_name }}',
          rightValue: "={{ $('Enforce Required Format').item.json.full_name.trim() }}",
          operator: { type: 'string', operation: 'notEquals' },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.merge_fields.FNAME }}',
          rightValue: "={{ $('Enforce Required Format').item.json.FNAME || $json.merge_fields.FNAME }}",
          operator: { type: 'string', operation: 'notEquals' },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.merge_fields.LNAME }}',
          rightValue: "={{ $('Enforce Required Format').item.json.LNAME || $json.merge_fields.LNAME }}",
          operator: { type: 'string', operation: 'notEquals' },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.merge_fields.COMPANY }}',
          rightValue: "={{ $('Enforce Required Format').item.json.COMPANY || $json.merge_fields.COMPANY }}",
          operator: { type: 'string', operation: 'notEquals' },
        },
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.should_claim }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'or',
    },
    options: {},
  },
  { position: [2400, -720], typeVersion: 2.2 },
);

// 8b. Filter: Tags Changed — only update tags when incoming has tags NOT already
// in the existing Mailchimp record (i.e., incoming is not a subset of existing).
// If Mailchimp already has all incoming tags, skip the update.
const filterTagsChanged = createNode(
  'Filter Tags Changed',
  'n8n-nodes-base.filter',
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
          leftValue: "={{ ($('Enforce Required Format').item.json.Tags || []).some(t => !($json.tags || []).map(x => x.name).includes(t)) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2400, -528], typeVersion: 2.2 },
);

// 9. Remove Cleaned Entries — skip if Mailchimp status is "cleaned"
const removeCleaned = createNode(
  'Remove Cleaned Entries',
  'n8n-nodes-base.filter',
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
          leftValue: '={{ $json.status }}',
          rightValue: 'cleaned',
          operator: { type: 'string', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2624, -720], typeVersion: 2.2 },
);

// 10. Build Update Record — merge incoming data with existing, include NOTIONID
const buildUpdate = createNode(
  'Build Update Record',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'email_address',
          value: "={{ $('Enforce Required Format').item.json.email_address }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'full_name',
          value: "={{ $('Enforce Required Format').item.json.full_name || $json.mailchimp.full_name }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'status',
          value: '={{ $json.status == "unsubscribed"? "unsubscribed" : $(\'Enforce Required Format\').item.json.status || $json.mailchimp.status }}',
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'FNAME',
          value: "={{ $('Enforce Required Format').item.json.FNAME || $json.merge_fields.FNAME }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'LNAME',
          value: "={{ $('Enforce Required Format').item.json.LNAME || $json.merge_fields.LNAME }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'ADDRESS',
          value: "={{ (() => { try { const a = JSON.parse($('Enforce Required Format').item.json.ADDRESS || '{}'); return a.addr1 ? $('Enforce Required Format').item.json.ADDRESS : ($json.merge_fields.ADDRESS || '') } catch(e) { return $json.merge_fields.ADDRESS || '' } })() }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'COMPANY',
          value: "={{ $('Enforce Required Format').item.json.COMPANY || $json.merge_fields.COMPANY }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'Tags',
          value: "={{ $('Enforce Required Format').item.json.Tags }}",
          type: 'array',
        },
        {
          id: crypto.randomUUID(),
          name: 'NOTIONID',
          value: "={{ $('Enforce Required Format').item.json.notion_page_id || $json.merge_fields.NOTIONID || '' }}",
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [2848, -720], typeVersion: 3.4 },
);

// 11. Update Subscribers — Mailchimp update with NOTIONID in merge fields
const updateSubs = createNode(
  'Update Subscribers',
  'n8n-nodes-base.mailchimp',
  {
    authentication: 'oAuth2',
    operation: 'update',
    list: MAILCHIMP_LIST_ID,
    email: '={{ $json.email_address }}',
    updateFields: {
      mergeFieldsUi: {
        mergeFieldsValues: [
          { name: 'FNAME', value: '={{ $json.FNAME }}' },
          { name: 'LNAME', value: '={{ $json.LNAME }}' },
          { name: 'COMPANY', value: '={{ $json.COMPANY }}' },
          { name: 'NOTIONID', value: '={{ $json.NOTIONID }}' },
        ],
      },
      status: '={{ $json.status }}',
    },
  },
  { position: [3072, -720], typeVersion: 1, credentials: MAILCHIMP_CREDENTIAL },
);
updateSubs.retryOnFail = true;
updateSubs.maxTries = 3;
updateSubs.waitBetweenTries = 2000;

// 12. Build Tags Field — diff old and new tags
// Now fed directly from Filter Tags Changed (not from Update Subscribers)
const buildTags = createNode(
  'Build Tags Field',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
let oldTags = $input.item.json.tags || [];
let newTags = $("Enforce Required Format").item.json.Tags || [];

// Build array showing status of each tag. Deleted tags become inactive.
let updatedTags = newTags.map(name => {
  return { "name": name, "status": "active" };
});

oldTags.forEach(obj => {
  if (newTags.find(x => x == obj.name) == undefined) {
    updatedTags.push({ "name": obj.name, "status": "inactive" });
  }
});

$input.item.json.updatedTags = updatedTags;
return $input.item;`,
  },
  { position: [2624, -528], typeVersion: 2 },
);

// 13. Record Tags — POST tag updates to Mailchimp API
const recordTags = createNode(
  'Record Tags',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: '={{ $json._links.find(x => x.rel == "self").href + "/tags" }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'mailchimpOAuth2Api',
    sendBody: true,
    bodyParameters: {
      parameters: [
        { name: 'tags', value: '={{ $json.updatedTags }}' },
      ],
    },
    options: {
      batching: {
        batch: { batchSize: 10, batchInterval: 2000 },
      },
    },
  },
  { position: [2848, -528], typeVersion: 4.3, credentials: MAILCHIMP_CREDENTIAL },
);
recordTags.retryOnFail = true;
recordTags.waitBetweenTries = 2000;

// ---------------------------------------------------------------------------
// Create branch
// ---------------------------------------------------------------------------

// 14. Insert New Subs — Mailchimp create with NOTIONID
const insertNew = createNode(
  'Insert New Subs',
  'n8n-nodes-base.mailchimp',
  {
    authentication: 'oAuth2',
    list: MAILCHIMP_LIST_ID,
    email: "={{ $('Enforce Required Format').item.json.email_address }}",
    status: "={{ $('Enforce Required Format').item.json.status || 'subscribed' }}",
    options: {
      tags: "={{ $('Enforce Required Format').item.json.Tags.join(\",\") }}",
    },
    mergeFieldsUi: {
      mergeFieldsValues: [
        { name: 'FNAME', value: "={{ $('Enforce Required Format').item.json.FNAME || '' }}" },
        { name: 'LNAME', value: "={{ $('Enforce Required Format').item.json.LNAME || '' }}" },
        { name: 'COMPANY', value: "={{ $('Enforce Required Format').item.json.COMPANY || '' }}" },
        { name: 'ADDRESS', value: "={{ (() => { try { const a = JSON.parse($('Enforce Required Format').item.json.ADDRESS || '{}'); return a.addr1 ? $('Enforce Required Format').item.json.ADDRESS : '' } catch(e) { return '' } })() }}" },
        { name: 'NOTIONID', value: "={{ $('Enforce Required Format').item.json.notion_page_id || '' }}" },
      ],
    },
  },
  { position: [2400, -240], typeVersion: 1, credentials: MAILCHIMP_CREDENTIAL },
);
insertNew.retryOnFail = true;
insertNew.maxTries = 3;
insertNew.waitBetweenTries = 2000;

// ---------------------------------------------------------------------------
// Notion write-back: store Mailchimp profile URL on the Notion contact
// ---------------------------------------------------------------------------
// On first claim (should_claim = true), write the Mailchimp admin URL back to
// the Notion contact's "Mailchimp Profile" url property. This creates a
// clickable link from Notion to the subscriber's Mailchimp profile.
//
// The write-back triggers a Notion webhook, but the next cycle will be
// absorbed: NOTIONID matches → Filter Unchanged drops it (no field changes).

// Helper: boolean "is true" check using the safe exists+true AND pattern
// per LESSONS.md (boolean operators are unreliable for missing fields)
function shouldClaimConditions() {
  return {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: crypto.randomUUID(),
        leftValue: "={{ $('NOTIONID Guard').item.json.should_claim }}",
        rightValue: '',
        operator: { type: 'boolean', operation: 'exists', singleValue: true },
      },
      {
        id: crypto.randomUUID(),
        leftValue: "={{ $('NOTIONID Guard').item.json.should_claim }}",
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      },
    ],
    combinator: 'and',
  };
}

// -- Update write-back path (fork from Update Subscribers) --

const claimFilterUpdate = createNode(
  'If Claiming',
  'n8n-nodes-base.filter',
  { conditions: shouldClaimConditions(), options: {} },
  { position: [3296, -720], typeVersion: 2.2 },
);

// Set node: extract web_id + data center from Mailchimp response, build admin URL
// Update path: Mailchimp fields are at $json top level
const buildWritebackUpdate = createNode(
  'Build Writeback URL',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'notion_page_id',
          value: "={{ $('Enforce Required Format').item.json.notion_page_id }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'mailchimp_url',
          value: "={{ 'https://' + $json._links.find(l => l.rel === 'self').href.replace('https://', '').split('.')[0] + '.admin.mailchimp.com/lists/members/view?id=' + $json.web_id }}",
          type: 'string',
        },
      ],
    },
    includeOtherFields: false,
    options: {},
  },
  { position: [3520, -720], typeVersion: 3.4 },
);

const writeUrlUpdate = createNode(
  'Write URL to Notion',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.notion_page_id }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ properties: { "Mailchimp Profile": { url: $json.mailchimp_url } } }) }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [3744, -720], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
writeUrlUpdate.retryOnFail = true;
writeUrlUpdate.maxTries = 3;
writeUrlUpdate.waitBetweenTries = 1000;

// -- Create write-back path (fork from Insert New Subs) --

const claimFilterCreate = createNode(
  'If Claiming (New)',
  'n8n-nodes-base.filter',
  { conditions: shouldClaimConditions(), options: {} },
  { position: [2624, -144], typeVersion: 2.2 },
);

// Create path: Mailchimp response is nested under $json.mailchimp
const buildWritebackCreate = createNode(
  'Build Writeback URL (New)',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: crypto.randomUUID(),
          name: 'notion_page_id',
          value: "={{ $('Enforce Required Format').item.json.notion_page_id }}",
          type: 'string',
        },
        {
          id: crypto.randomUUID(),
          name: 'mailchimp_url',
          value: "={{ 'https://' + ($json.mailchimp || $json)._links.find(l => l.rel === 'self').href.replace('https://', '').split('.')[0] + '.admin.mailchimp.com/lists/members/view?id=' + ($json.mailchimp || $json).web_id }}",
          type: 'string',
        },
      ],
    },
    includeOtherFields: false,
    options: {},
  },
  { position: [2848, -144], typeVersion: 3.4 },
);

const writeUrlCreate = createNode(
  'Write URL to Notion (New)',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.notion_page_id }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ properties: { "Mailchimp Profile": { url: $json.mailchimp_url } } }) }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 334 } },
    },
  },
  { position: [3072, -144], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
writeUrlCreate.retryOnFail = true;
writeUrlCreate.maxTries = 3;
writeUrlCreate.waitBetweenTries = 1000;

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Create or Update Mailchimp Record', {
  nodes: [
    trigger, enforceFormat, validateEmail, emailValid, serviceDown,
    findExisting, validateLookup, enforceEmailLower,
    notionIdGuard, guardFilter, switchNode,
    // Update branch — merge fields path
    filterMergeFields, removeCleaned, buildUpdate, updateSubs,
    // Update branch — tags path
    filterTagsChanged, buildTags, recordTags,
    // Update write-back
    claimFilterUpdate, buildWritebackUpdate, writeUrlUpdate,
    // Create branch
    insertNew,
    // Create write-back
    claimFilterCreate, buildWritebackCreate, writeUrlCreate,
  ],
  connections: [
    // Main chain
    connect(trigger, enforceFormat),
    connect(enforceFormat, validateEmail),
    connect(validateEmail, emailValid, 0),        // success → mx/spam filter
    connect(validateEmail, serviceDown, 1),       // error → check status code
    connect(emailValid, findExisting),
    connect(serviceDown, findExisting, 0),        // true (5xx) → bypass, let through
    // false (4xx) → bad email, silently dropped
    connect(findExisting, validateLookup),
    connect(validateLookup, enforceEmailLower),
    connect(enforceEmailLower, notionIdGuard),
    connect(notionIdGuard, guardFilter),
    connect(guardFilter, switchNode),
    // Switch output 0 (Update) → two independent paths
    connect(switchNode, filterMergeFields, 0),
    connect(switchNode, filterTagsChanged, 0),
    // Switch output 1 (Create) → create branch
    connect(switchNode, insertNew, 1),
    // Merge fields path: filter → remove cleaned → build → update
    connect(filterMergeFields, removeCleaned),
    connect(removeCleaned, buildUpdate),
    connect(buildUpdate, updateSubs),
    // Write-back fork from Update Subscribers
    connect(updateSubs, claimFilterUpdate),
    connect(claimFilterUpdate, buildWritebackUpdate),
    connect(buildWritebackUpdate, writeUrlUpdate),
    // Tags path: filter → build tags → record tags
    connect(filterTagsChanged, buildTags),
    connect(buildTags, recordTags),
    // Create write-back (parallel fork from Insert New Subs)
    connect(insertNew, claimFilterCreate),
    connect(claimFilterCreate, buildWritebackCreate),
    connect(buildWritebackCreate, writeUrlCreate),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
