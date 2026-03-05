/**
 * Email Activity Log
 *
 * Hourly workflow that:
 *   1. Polls Microsoft 365 inbox and sent items via Graph API
 *   2. Matches email addresses against known contacts in Notion
 *   3. Deduplicates against existing activity records
 *   4. Creates activity records in the Notion Activities database
 *   5. Generates AI summaries of each email using Claude Haiku
 *   6. Writes summaries to the Notion page body
 *
 * Only emails where the sender (received) or a recipient (sent)
 * matches a known contact are logged. One activity per email.
 *
 * Prerequisites:
 *   - Activities database created in Notion (see ACTIVITIES_DB_ID)
 *   - Microsoft Outlook OAuth2 credential with Mail.Read scope
 *   - Anthropic API credential for Haiku summaries
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Web DB: Activities
const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8';

const CONTACTS_DB_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';

// Lookback window: 2h gives 1h overlap on hourly runs for safety
const LOOKBACK_HOURS = 2;

// Graph API field selection — includes body for AI summarization
const GRAPH_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// Placeholder — must be created in n8n with Mail.Read + Mail.Send scopes
const OUTLOOK_CREDENTIAL = {
  microsoftOutlookOAuth2Api: { id: 'TODO', name: 'Eve Outlook Account' },
};

const ANTHROPIC_CREDENTIAL = {
  anthropicApi: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// ---------------------------------------------------------------------------
// Shared Code Strings
// ---------------------------------------------------------------------------

const TAG_EMAIL_CODE = (direction) => `
const items = $input.all();
const results = [];

for (const item of items) {
  const j = item.json;

  // Handle Graph API response — items may be in a 'value' array or flat
  const emails = Array.isArray(j.value) ? j.value : [j];

  for (const email of emails) {
    if (!email.id) continue;

    // Strip HTML from body to plain text, truncate for storage + LLM
    let bodyText = '';
    if (email.body && email.body.content) {
      bodyText = email.body.content
        .replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\\s+/g, ' ')
        .trim()
        .substring(0, 2000);
    }

    const fromAddr = (email.from && email.from.emailAddress && email.from.emailAddress.address) || '';
    const toAddrs = (email.toRecipients || [])
      .map(r => r.emailAddress && r.emailAddress.address)
      .filter(Boolean);
    const ccAddrs = (email.ccRecipients || [])
      .map(r => r.emailAddress && r.emailAddress.address)
      .filter(Boolean);

    results.push({
      json: {
        _type: 'email',
        _direction: '${direction}',
        _messageId: email.id,
        _subject: (email.subject || '').substring(0, 200),
        _fromAddress: fromAddr.toLowerCase(),
        _toAddresses: toAddrs.map(a => a.toLowerCase()),
        _ccAddresses: ccAddrs.map(a => a.toLowerCase()),
        _date: email.${direction === 'received' ? 'receivedDateTime' : 'sentDateTime'} || email.receivedDateTime || '',
        _bodyText: bodyText,
        _preview: (email.bodyPreview || '').substring(0, 255),
      },
    });
  }
}

if (results.length === 0) {
  return [{ json: { _type: 'email', _empty: true } }];
}
return results;
`;

const MATCH_DEDUP_CODE = `
const ACTIVITIES_DB_ID = '${ACTIVITIES_DB_ID}';
const allItems = $input.all();

// --- Separate item types ---
let contactsList = [];
let activitiesList = [];
const emails = [];

for (const item of allItems) {
  const j = item.json;
  if (j.contacts && Array.isArray(j.contacts)) {
    contactsList = j.contacts;
  } else if (j.activities && Array.isArray(j.activities)) {
    activitiesList = j.activities;
  } else if (j._type === 'email' && !j._empty) {
    emails.push(j);
  }
}

// --- Build contact email → page ID lookup ---
const contactByEmail = new Map();
for (const c of contactsList) {
  const email = (c.property_email || c.property_identifier || c.name || '')
    .toString().trim().toLowerCase();
  if (email && email.includes('@')) {
    contactByEmail.set(email, {
      pageId: c.id,
      name: c.property_first_name
        ? (c.property_first_name + ' ' + (c.property_last_name || '')).trim()
        : c.name || email,
    });
  }
}

// --- Build existing message ID set for dedup ---
const existingMessageIds = new Set();
for (const a of activitiesList) {
  const msgId = a.property_message_id;
  if (msgId) existingMessageIds.add(msgId);
}

// --- Match emails to contacts, build Notion create bodies ---
const newActivities = [];

for (const email of emails) {
  if (existingMessageIds.has(email._messageId)) continue;

  let matchedContact = null;
  let matchedEmail = '';

  if (email._direction === 'received') {
    const sender = email._fromAddress;
    if (contactByEmail.has(sender)) {
      matchedContact = contactByEmail.get(sender);
      matchedEmail = sender;
    }
  } else {
    // Sent: check TO recipients first, then CC
    for (const addr of email._toAddresses) {
      if (contactByEmail.has(addr)) {
        matchedContact = contactByEmail.get(addr);
        matchedEmail = addr;
        break;
      }
    }
    if (!matchedContact) {
      for (const addr of email._ccAddresses) {
        if (contactByEmail.has(addr)) {
          matchedContact = contactByEmail.get(addr);
          matchedEmail = addr;
          break;
        }
      }
    }
  }

  if (!matchedContact) continue;

  const properties = {
    'Name': {
      title: [{ text: { content: (email._subject || '(no subject)').substring(0, 100) } }],
    },
    'Contact': {
      relation: [{ id: matchedContact.pageId }],
    },
    'Direction': {
      select: { name: email._direction === 'sent' ? 'Sent' : 'Received' },
    },
    'Date': {
      date: { start: email._date },
    },
    'Subject': {
      rich_text: [{ text: { content: (email._subject || '').substring(0, 200) } }],
    },
    'Email Address': {
      email: matchedEmail,
    },
    'Message ID': {
      rich_text: [{ text: { content: email._messageId } }],
    },
  };

  // Only include Preview if we have body text
  if (email._bodyText) {
    properties['Preview'] = {
      rich_text: [{ text: { content: email._bodyText.substring(0, 2000) } }],
    };
  }

  const requestBody = JSON.stringify({
    parent: { database_id: ACTIVITIES_DB_ID },
    properties,
  });

  newActivities.push({ json: { requestBody, _empty: false } });
}

if (newActivities.length === 0) {
  return [{ json: { _empty: true } }];
}
return newActivities;
`;

const BUILD_LLM_PROMPT_CODE = `
// Read page ID and email body from the Notion create response
const pageId = $json.id;
const preview = ($json.properties
  && $json.properties.Preview
  && $json.properties.Preview.rich_text
  && $json.properties.Preview.rich_text[0]
  && $json.properties.Preview.rich_text[0].text
  && $json.properties.Preview.rich_text[0].text.content) || '';
const subject = ($json.properties
  && $json.properties.Name
  && $json.properties.Name.title
  && $json.properties.Name.title[0]
  && $json.properties.Name.title[0].text
  && $json.properties.Name.title[0].text.content) || '';

if (!preview || preview.length < 20) {
  // Too short to summarize meaningfully — skip
  return { json: { pageId, anthropicBody: '', _skipSummary: true } };
}

const prompt = \`Summarize the key points of this email in 2-3 concise bullet points. Each bullet should be one sentence. Do not include greetings, sign-offs, or boilerplate.

Subject: \${subject}

\${preview}\`;

const anthropicBody = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 300,
  messages: [{ role: 'user', content: prompt }],
});

return { json: { pageId, anthropicBody, _skipSummary: false } };
`;

const BUILD_LAST_CONTACTED_CODE = `
// Extract contact page IDs from successful Notion create responses
// and build PATCH request bodies for updating the "Last Contacted" date.
// Runs after createActivity so $input items are Notion API create responses.
const today = new Date().toISOString().split('T')[0];

return $input.all()
  .filter(item => item.json.properties?.Contact?.relation?.[0]?.id)
  .map(item => {
    const contactId = item.json.properties.Contact.relation[0].id;
    return {
      json: {
        contactId,
        patchBody: JSON.stringify({
          properties: {
            'Last Contacted': { date: { start: today } },
          },
        }),
      },
    };
  });
`;

const WRITE_SUMMARY_CODE = `
// Input 0 (from Summarize Email): Anthropic response
// Input 1 (from passthrough): { pageId, ... }
// After combineByPosition merge, both are combined into one item

const pageId = $json.pageId;
const skipSummary = $json._skipSummary;

if (skipSummary || !pageId) {
  return { json: { _skip: true } };
}

// Extract summary text from Anthropic response
let summary = '';
if ($json.content && Array.isArray($json.content) && $json.content[0]) {
  summary = $json.content[0].text || '';
}

if (!summary) {
  return { json: { _skip: true } };
}

// Build Notion blocks for page body
const blocks = {
  children: [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [{ type: 'text', text: { content: 'AI Summary' } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: summary } }],
      },
    },
  ],
};

return {
  json: {
    pageId,
    blocksBody: JSON.stringify(blocks),
    _skip: false,
  },
};
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Schedule Trigger — hourly
const scheduleTrigger = createNode(
  'Hourly Trigger',
  'n8n-nodes-base.scheduleTrigger',
  { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
  { position: [0, 400], typeVersion: 1.2 },
);

// 2. Get All Contacts
const getAllContacts = createNode(
  'Get All Contacts',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: CONTACTS_DB_ID },
    returnAll: true,
  },
  { position: [224, 100], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getAllContacts.retryOnFail = true;
getAllContacts.maxTries = 3;
getAllContacts.waitBetweenTries = 1000;

// 3. Aggregate Contacts
const aggregateContacts = createNode(
  'Aggregate Contacts',
  'n8n-nodes-base.aggregate',
  {
    aggregate: 'aggregateAllItemData',
    destinationFieldName: 'contacts',
    options: {},
  },
  { position: [448, 100], typeVersion: 1 },
);

// 4. Get Inbox Emails
const lookbackFilter = `=receivedDateTime ge '{{ DateTime.now().minus({ hours: ${LOOKBACK_HOURS} }).toISO() }}'`;

const getInboxEmails = createNode(
  'Get Inbox Emails',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: '$filter', value: lookbackFilter },
        { name: '$select', value: GRAPH_SELECT },
        { name: '$top', value: '100' },
        { name: '$orderby', value: 'receivedDateTime desc' },
      ],
    },
    options: {},
  },
  { position: [224, 300], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
getInboxEmails.retryOnFail = true;
getInboxEmails.maxTries = 3;
getInboxEmails.waitBetweenTries = 1000;

// 5. Tag Inbox
const tagInbox = createNode(
  'Tag Inbox',
  'n8n-nodes-base.code',
  { jsCode: TAG_EMAIL_CODE('received'), mode: 'runOnceForAllItems' },
  { position: [448, 300], typeVersion: 2 },
);

// 6. Get Sent Emails
const sentLookbackFilter = `=sentDateTime ge '{{ DateTime.now().minus({ hours: ${LOOKBACK_HOURS} }).toISO() }}'`;

const getSentEmails = createNode(
  'Get Sent Emails',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: 'https://graph.microsoft.com/v1.0/me/mailFolders/sentItems/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: '$filter', value: sentLookbackFilter },
        { name: '$select', value: GRAPH_SELECT },
        { name: '$top', value: '100' },
        { name: '$orderby', value: 'sentDateTime desc' },
      ],
    },
    options: {},
  },
  { position: [224, 500], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
getSentEmails.retryOnFail = true;
getSentEmails.maxTries = 3;
getSentEmails.waitBetweenTries = 1000;

// 7. Tag Sent
const tagSent = createNode(
  'Tag Sent',
  'n8n-nodes-base.code',
  { jsCode: TAG_EMAIL_CODE('sent'), mode: 'runOnceForAllItems' },
  { position: [448, 500], typeVersion: 2 },
);

// 8. Get Recent Activities (for dedup)
const getRecentActivities = createNode(
  'Get Recent Activities',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: ACTIVITIES_DB_ID },
    returnAll: true,
    filterType: 'manual',
    matchType: 'anyFilter',
    filters: {
      conditions: [
        {
          key: 'Date|date',
          condition: 'pastWeek',
        },
      ],
    },
    options: {},
  },
  { position: [224, 700], typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
);
getRecentActivities.retryOnFail = true;
getRecentActivities.maxTries = 3;
getRecentActivities.waitBetweenTries = 1000;
getRecentActivities.alwaysOutputData = true;

// 9. Aggregate Activities
const aggregateActivities = createNode(
  'Aggregate Activities',
  'n8n-nodes-base.aggregate',
  {
    aggregate: 'aggregateAllItemData',
    destinationFieldName: 'activities',
    options: {},
  },
  { position: [448, 700], typeVersion: 1 },
);

// 10. Merge Inbox + Sent
const mergeInboxSent = createNode(
  'Merge Inbox + Sent',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [672, 400], typeVersion: 3 },
);

// 11. Merge Contacts + Emails
const mergeContactsEmails = createNode(
  'Merge Contacts + Emails',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [896, 250], typeVersion: 3 },
);

// 12. Merge All + Activities
const mergeAllActivities = createNode(
  'Merge All + Activities',
  'n8n-nodes-base.merge',
  { mode: 'append' },
  { position: [1120, 400], typeVersion: 3 },
);

// 13. Match & Dedup
const matchAndDedup = createNode(
  'Match & Dedup',
  'n8n-nodes-base.code',
  { jsCode: MATCH_DEDUP_CODE, mode: 'runOnceForAllItems' },
  { position: [1344, 400], typeVersion: 2 },
);

// 14. Has New Activities?
const hasNewActivities = createNode(
  'Has New Activities?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'activity-check',
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1568, 400], typeVersion: 2 },
);

// 15. Create Activity (HTTP POST to Notion)
const createActivity = createNode(
  'Create Activity',
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
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [1792, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createActivity.retryOnFail = true;
createActivity.maxTries = 3;
createActivity.waitBetweenTries = 1000;
createActivity.continueOnFail = true;

// 16. Build LLM Prompt
const buildLlmPrompt = createNode(
  'Build LLM Prompt',
  'n8n-nodes-base.code',
  { jsCode: BUILD_LLM_PROMPT_CODE, mode: 'runOnceForEachItem' },
  { position: [2016, 400], typeVersion: 2 },
);

// 17. Summarize Email (HTTP POST to Anthropic)
const summarizeEmail = createNode(
  'Summarize Email',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.anthropicBody }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 200,
        },
      },
    },
  },
  { position: [2240, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
summarizeEmail.retryOnFail = true;
summarizeEmail.maxTries = 2;
summarizeEmail.waitBetweenTries = 1000;
summarizeEmail.continueOnFail = true;

// 18. Merge Summary + Context (preserves pageId through Anthropic call)
const mergeSummaryContext = createNode(
  'Merge Summary + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition' },
  { position: [2464, 400], typeVersion: 3 },
);

// 19. Write Summary to Page
const writeSummaryCode = createNode(
  'Write Summary to Page',
  'n8n-nodes-base.code',
  { jsCode: WRITE_SUMMARY_CODE, mode: 'runOnceForEachItem' },
  { position: [2688, 400], typeVersion: 2 },
);

// 21. Build Last Contacted Patch (Code, runOnceForAllItems)
//     Parallel branch from createActivity. Extracts the contact page ID from
//     each Notion create response and builds a PATCH body for today's date.
//     Items without a Contact relation are silently dropped.
const buildLastContactedPatch = createNode(
  'Build Last Contacted Patch',
  'n8n-nodes-base.code',
  { jsCode: BUILD_LAST_CONTACTED_CODE, mode: 'runOnceForAllItems' },
  { position: [2016, 600], typeVersion: 2 },
);

// 22. Update Last Contacted (HTTP PATCH to Notion pages API)
//     PATCHes the "Last Contacted" date property on the matched Contact page.
//     Runs in parallel with the LLM summary chain — does not block it.
//     Prerequisite: "Last Contacted" (date) property must exist on Contacts DB.
const updateLastContacted = createNode(
  'Update Last Contacted',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.contactId }}',
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
    jsonBody: '={{ $json.patchBody }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [2240, 600], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
updateLastContacted.retryOnFail = true;
updateLastContacted.maxTries = 3;
updateLastContacted.waitBetweenTries = 1000;
updateLastContacted.continueOnFail = true;

// 20. Update Page Body (HTTP PATCH to Notion blocks API)
const updatePageBody = createNode(
  'Update Page Body',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/blocks/{{ $json.pageId }}/children',
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
    jsonBody: '={{ $json.blocksBody }}',
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: 334,
        },
      },
    },
  },
  { position: [2912, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
updatePageBody.retryOnFail = true;
updatePageBody.maxTries = 3;
updatePageBody.waitBetweenTries = 1000;
updatePageBody.continueOnFail = true;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('Email Activity Log', {
  nodes: [
    scheduleTrigger,
    getAllContacts,
    aggregateContacts,
    getInboxEmails,
    tagInbox,
    getSentEmails,
    tagSent,
    getRecentActivities,
    aggregateActivities,
    mergeInboxSent,
    mergeContactsEmails,
    mergeAllActivities,
    matchAndDedup,
    hasNewActivities,
    createActivity,
    buildLlmPrompt,
    summarizeEmail,
    mergeSummaryContext,
    writeSummaryCode,
    updatePageBody,
    buildLastContactedPatch,
    updateLastContacted,
  ],
  connections: [
    // Trigger → 4 parallel fetch branches
    connect(scheduleTrigger, getAllContacts),
    connect(scheduleTrigger, getInboxEmails),
    connect(scheduleTrigger, getSentEmails),
    connect(scheduleTrigger, getRecentActivities),

    // Branch 1: Contacts → Aggregate
    connect(getAllContacts, aggregateContacts),

    // Branch 2: Inbox → Tag
    connect(getInboxEmails, tagInbox),

    // Branch 3: Sent → Tag
    connect(getSentEmails, tagSent),

    // Branch 4: Activities → Aggregate
    connect(getRecentActivities, aggregateActivities),

    // Merge emails
    connect(tagInbox, mergeInboxSent, 0, 0),
    connect(tagSent, mergeInboxSent, 0, 1),

    // Merge contacts + emails
    connect(aggregateContacts, mergeContactsEmails, 0, 0),
    connect(mergeInboxSent, mergeContactsEmails, 0, 1),

    // Merge all + activities
    connect(mergeContactsEmails, mergeAllActivities, 0, 0),
    connect(aggregateActivities, mergeAllActivities, 0, 1),

    // Process → Gate → Create
    connect(mergeAllActivities, matchAndDedup),
    connect(matchAndDedup, hasNewActivities),
    connect(hasNewActivities, createActivity, 0),  // true branch

    // Create → Build prompt → fork for summary
    connect(createActivity, buildLlmPrompt),
    connect(buildLlmPrompt, summarizeEmail),         // branch to Anthropic
    connect(buildLlmPrompt, mergeSummaryContext, 0, 1),  // passthrough (preserves pageId)
    connect(summarizeEmail, mergeSummaryContext, 0, 0),   // Anthropic response

    // Merge → format blocks → write to page
    connect(mergeSummaryContext, writeSummaryCode),
    connect(writeSummaryCode, updatePageBody),

    // Last Contacted write-back (parallel branch from createActivity)
    connect(createActivity, buildLastContactedPatch),
    connect(buildLastContactedPatch, updateLastContacted),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
