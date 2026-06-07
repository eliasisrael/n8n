/**
 * Email Graph Webhook
 *
 * Receives Microsoft Graph change notifications for Eve's inbox and sent
 * items, then for each new message:
 *   1. Fetches the full message from Graph
 *   2. Matches sender (received) or recipients (sent) to a Notion contact
 *   3. Looks up the contact's OPEN pipeline items in Sales / Partner / Comms
 *   4. Creates an Activity record in Notion with Contact + open-pipeline relations
 *   5. Generates an AI summary with Claude Haiku and writes it to the page body
 *
 * The downstream "PATCH Last Activity on contact + pipeline items" is handled
 * by activity-webhook.js, triggered automatically when Adapter: Activities sees
 * the new record. We don't do it here.
 *
 * Two Microsoft Graph subscriptions point at this endpoint (one for inbox, one
 * for sent items). They distinguish direction via clientState suffix:
 *   - `<secret>-inbox`  → received
 *   - `<secret>-sent`   → sent
 *
 * On subscription creation, Graph sends a POST with ?validationToken=... and
 * expects the token echoed back as text/plain within 10 seconds. We handle
 * that as the first branch of the IF.
 *
 * Companion workflow: email-subscription-manager.js (creates + renews subs).
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';
import loadEnv from '../lib/load-env.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8';
const CONTACTS_DB_ID = '1688ebaf-15ee-806b-bd12-dd7c8caf2bdd';

const PIPELINES = {
  sales: {
    dbId: '2ed21e43d3a545f48cf4a2a8f61a264f',
    relationProp: 'Sales pipeline',
    terminalStatuses: ['Lost/rejected', 'Completed', 'Signed 100%'],
  },
  partner: {
    dbId: '457cfa4c123b4718a7d3c8bf7ea4a27e',
    relationProp: 'Partner pipeline',
    terminalStatuses: ['Closed/signed', 'Lost/rejected'],
  },
  comms: {
    dbId: '35d10c8392e64ce2adc28c03e2c97480',
    relationProp: 'Comms pipeline',
    terminalStatuses: ['Completed/Captured', 'Rejected/Cancelled', 'VF delivered', 'Confirmed'],
  },
};

const GRAPH_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,parentFolderId';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const OUTLOOK_CREDENTIAL = {
  microsoftOutlookOAuth2Api: { id: 'xUInnrPuP6ogucEt', name: 'Microsoft Outlook account' },
};

const ANTHROPIC_CREDENTIAL = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// Shared secret with Graph (set on the subscription's clientState). Compared
// against `clientState` on every incoming notification.
const CLIENT_STATE_SECRET = env.GRAPH_WEBHOOK_CLIENT_STATE || 'CHANGE_ME_VIA_OP_RUN';

// ---------------------------------------------------------------------------
// Code: validate clientState + expand notifications into items
// ---------------------------------------------------------------------------
const EXPAND_NOTIFICATIONS_CODE = `
const SECRET = ${JSON.stringify(CLIENT_STATE_SECRET)};
const body = $json.body || {};
const notifications = Array.isArray(body.value) ? body.value : [];

let invalid = false;
const valid = [];

for (const n of notifications) {
  const cs = n.clientState || '';
  if (!cs.startsWith(SECRET + '-')) {
    invalid = true;
    continue;
  }
  if (n.changeType !== 'created') continue;
  const direction = cs.endsWith('-sent') ? 'sent' : 'received';
  const messageId = (n.resourceData && n.resourceData.id) || '';
  if (!messageId) continue;
  valid.push({
    json: {
      _messageId: messageId,
      _direction: direction,
      _resource: n.resource || ('me/messages/' + messageId),
    },
  });
}

if (invalid) {
  return [{ json: { _invalidClientState: true } }];
}
if (valid.length === 0) {
  return [{ json: { _empty: true } }];
}
return valid;
`;

// ---------------------------------------------------------------------------
// Code: tag a single fetched email (HTML strip, address normalize). Adapted
// from email-activity-log.js lines 55-113 but for single-item input.
// ---------------------------------------------------------------------------
const TAG_EMAIL_CODE = `
const email = $json;
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

const direction = $('Expand Notifications').item.json._direction;
const messageId = $('Expand Notifications').item.json._messageId;

const fromAddr = (email.from && email.from.emailAddress && email.from.emailAddress.address) || '';
const toAddrs = (email.toRecipients || [])
  .map(r => r.emailAddress && r.emailAddress.address)
  .filter(Boolean);
const ccAddrs = (email.ccRecipients || [])
  .map(r => r.emailAddress && r.emailAddress.address)
  .filter(Boolean);

return {
  json: {
    _messageId: messageId,
    _direction: direction,
    _subject: (email.subject || '').substring(0, 200),
    _fromAddress: fromAddr.toLowerCase(),
    _toAddresses: toAddrs.map(a => a.toLowerCase()),
    _ccAddresses: ccAddrs.map(a => a.toLowerCase()),
    _date: (direction === 'sent' ? email.sentDateTime : email.receivedDateTime) || email.receivedDateTime || email.sentDateTime || '',
    _bodyText: bodyText,
    _preview: (email.bodyPreview || '').substring(0, 255),
  },
};
`;

// ---------------------------------------------------------------------------
// Code: build a Notion contacts-DB query body for the email's match candidates
// ---------------------------------------------------------------------------
const BUILD_CONTACT_QUERY_CODE = `
const CONTACTS_DB_ID = ${JSON.stringify(CONTACTS_DB_ID)};
const j = $json;

let candidates = [];
if (j._direction === 'received') {
  candidates = [j._fromAddress];
} else {
  candidates = [...(j._toAddresses || []), ...(j._ccAddresses || [])];
}
candidates = candidates.filter(Boolean);

if (candidates.length === 0) {
  return { json: { ...j, _noCandidates: true } };
}

const queryBody = JSON.stringify({
  filter: {
    or: candidates.map(addr => ({
      property: 'Identifier',
      title: { equals: addr },
    })),
  },
  page_size: 5,
});

return {
  json: {
    ...j,
    _candidates: candidates,
    _queryBody: queryBody,
    _contactsDbId: CONTACTS_DB_ID,
  },
};
`;

// ---------------------------------------------------------------------------
// Code: pick the first matching contact (preserving direction priority for sent)
// ---------------------------------------------------------------------------
const MATCH_CONTACT_CODE = `
// $json = Notion query response; back-reference for email context
const ctx = $('Build Contact Query').item.json;
const results = ($json.results || []);

// Build email → page map from results
const byEmail = new Map();
for (const page of results) {
  const titleProp = page.properties && page.properties.Identifier && page.properties.Identifier.title;
  const email = (titleProp && titleProp[0] && titleProp[0].plain_text || '').toLowerCase();
  if (email) byEmail.set(email, page.id);
}

let matchedEmail = '';
let matchedContactId = '';
const candidates = ctx._candidates || [];
for (const addr of candidates) {
  if (byEmail.has(addr)) {
    matchedEmail = addr;
    matchedContactId = byEmail.get(addr);
    break;
  }
}

if (!matchedContactId) {
  return { json: { ...ctx, _noMatch: true } };
}

return {
  json: {
    ...ctx,
    _matchedEmail: matchedEmail,
    _matchedContactId: matchedContactId,
  },
};
`;

// ---------------------------------------------------------------------------
// Code: emit 3 pipeline-query items (one per pipeline DB) with ctx preserved
// ---------------------------------------------------------------------------
const EMIT_PIPELINE_QUERIES_CODE = `
const PIPELINES = ${JSON.stringify(PIPELINES)};
const ctx = $json;

const out = [];
for (const [type, p] of Object.entries(PIPELINES)) {
  // Build a filter: Contact contains matched contact AND Status not in terminals
  const statusFilters = p.terminalStatuses.map(s => ({
    property: 'Status',
    status: { does_not_equal: s },
  }));

  const filter = {
    and: [
      { property: 'Contact', relation: { contains: ctx._matchedContactId } },
      ...statusFilters,
    ],
  };

  const queryBody = JSON.stringify({
    filter,
    page_size: 25,
  });

  out.push({
    json: {
      _ctx: ctx,
      _pipelineType: type,
      _pipelineDbId: p.dbId,
      _queryBody: queryBody,
    },
  });
}

return out;
`;

// ---------------------------------------------------------------------------
// Code: aggregate the 3 pipeline-query responses into one open-items map
// ---------------------------------------------------------------------------
const AGGREGATE_OPEN_PIPELINES_CODE = `
// Input items: each is a Notion query response paired with _ctx + _pipelineType
// via the upstream Merge (combineByPosition).
const items = $input.all();

let ctx = null;
const open = { sales: [], partner: [], comms: [] };

for (const item of items) {
  const j = item.json;
  if (!ctx && j._ctx) ctx = j._ctx;
  const type = j._pipelineType;
  const results = j.results || [];
  if (!type || !Array.isArray(results)) continue;
  for (const page of results) {
    if (page && page.id) open[type].push(page.id);
  }
}

if (!ctx) {
  return [{ json: { _noContext: true } }];
}

return [{
  json: {
    ...ctx,
    _openPipelines: open,
  },
}];
`;

// ---------------------------------------------------------------------------
// Code: build Notion Activity-create request body, including pipeline relations
// ---------------------------------------------------------------------------
const BUILD_ACTIVITY_CODE = `
const ACTIVITIES_DB_ID = ${JSON.stringify(ACTIVITIES_DB_ID)};
const j = $json;

function formatEmailDatetime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const date = d.toISOString().slice(0, 10);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return date + ' ' + hh + ':' + mm;
}

function subjectKeyDetail(subject) {
  const clean = (subject || '').replace(/^(Re|Fwd?|FW|AW|TR):\\s*/i, '').trim();
  const words = clean.split(/\\s+/).filter(Boolean).slice(0, 3);
  return words.join(' ') || '(no subject)';
}

const emailType = j._direction === 'sent' ? 'Email Sent' : 'Email Received';
const emailDateStr = formatEmailDatetime(j._date);
const emailKeyDetail = subjectKeyDetail(j._subject);
const activityName = (emailType + ' · ' + emailDateStr + ' · ' + emailKeyDetail).substring(0, 100);

const properties = {
  'Name': { title: [{ text: { content: activityName } }] },
  'Contact': { relation: [{ id: j._matchedContactId }] },
  'Direction': { select: { name: j._direction === 'sent' ? 'Sent' : 'Received' } },
  'Date': { date: { start: j._date } },
  'Subject': { rich_text: [{ text: { content: (j._subject || '').substring(0, 200) } }] },
  'Email Address': { email: j._matchedEmail },
  'Message ID': { rich_text: [{ text: { content: j._messageId } }] },
};

if (j._bodyText) {
  properties['Preview'] = { rich_text: [{ text: { content: j._bodyText.substring(0, 2000) } }] };
}

const open = j._openPipelines || { sales: [], partner: [], comms: [] };
if (open.sales.length) {
  properties['Sales pipeline'] = { relation: open.sales.map(id => ({ id })) };
}
if (open.partner.length) {
  properties['Partner pipeline'] = { relation: open.partner.map(id => ({ id })) };
}
if (open.comms.length) {
  properties['Comms pipeline'] = { relation: open.comms.map(id => ({ id })) };
}

return {
  json: {
    _messageId: j._messageId,
    requestBody: JSON.stringify({
      parent: { database_id: ACTIVITIES_DB_ID },
      properties,
    }),
  },
};
`;

// ---------------------------------------------------------------------------
// Code: build Anthropic prompt body from the created Activity (reused from
// email-activity-log.js lines 260-294, verbatim).
// ---------------------------------------------------------------------------
const BUILD_LLM_PROMPT_CODE = `
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

// ---------------------------------------------------------------------------
// Code: build Notion blocks body from Anthropic response (verbatim from
// email-activity-log.js lines 319-368).
// ---------------------------------------------------------------------------
const WRITE_SUMMARY_CODE = `
const pageId = $json.pageId;
const skipSummary = $json._skipSummary;

if (skipSummary || !pageId) {
  return { json: { _skip: true } };
}

let summary = '';
if ($json.content && Array.isArray($json.content) && $json.content[0]) {
  summary = $json.content[0].text || '';
}

if (!summary) {
  return { json: { _skip: true } };
}

const blocks = {
  children: [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: 'AI Summary' } }] },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: summary } }] },
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

// 1. Webhook (POST). Accepts both validation handshake and notification posts.
const webhook = createNode(
  'Webhook',
  'n8n-nodes-base.webhook',
  {
    httpMethod: 'POST',
    path: 'email-graph-notify',
    responseMode: 'responseNode',
    options: { rawBody: false },
  },
  { position: [0, 400], typeVersion: 2 },
);
// createNode opts don't pass through webhookId — set it after construction.
// Without this, n8n stores webhookId as null and the active workflow never
// registers the production webhook (any request returns 404).
webhook.webhookId = 'email-graph-notify';

// 2. IF: validation handshake?
const isValidationHandshake = createNode(
  'Is Validation Handshake?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'validation-token-check',
          leftValue: '={{ $json.query.validationToken }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [224, 400], typeVersion: 2 },
);

// 3a. Respond Validation — echo token as text/plain
const respondValidation = createNode(
  'Respond Validation',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'text',
    responseBody: '={{ $json.query.validationToken }}',
    options: {
      responseCode: 200,
      responseHeaders: {
        entries: [{ name: 'Content-Type', value: 'text/plain' }],
      },
    },
  },
  { position: [448, 300], typeVersion: 1.1 },
);

// 3b. Expand Notifications (Code): validate clientState + extract messageIds
const expandNotifications = createNode(
  'Expand Notifications',
  'n8n-nodes-base.code',
  { jsCode: EXPAND_NOTIFICATIONS_CODE, mode: 'runOnceForAllItems' },
  { position: [448, 500], typeVersion: 2 },
);

// 4. IF: clientState valid?
const isClientStateValid = createNode(
  'Client State Valid?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'invalid-cs-check',
          leftValue: '={{ $json._invalidClientState }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [672, 500], typeVersion: 2 },
);

// 5a. Respond 401 — invalid clientState
const respond401 = createNode(
  'Respond 401',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'text',
    responseBody: 'Unauthorized',
    options: { responseCode: 401 },
  },
  { position: [896, 700], typeVersion: 1.1 },
);

// 5b. Respond 202 — accept and process async (downstream continues)
const respond202 = createNode(
  'Respond 202',
  'n8n-nodes-base.respondToWebhook',
  {
    respondWith: 'text',
    responseBody: 'Accepted',
    options: { responseCode: 202 },
  },
  { position: [896, 500], typeVersion: 1.1 },
);

// 6. IF: any notifications to process? (filters out the _empty sentinel)
const hasNotifications = createNode(
  'Has Notifications?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'has-msg-check',
          leftValue: '={{ $json._messageId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [1120, 500], typeVersion: 2 },
);

// 7. Get Message from Graph (per notification item)
const getMessage = createNode(
  'Get Message',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: '=https://graph.microsoft.com/v1.0/me/messages/{{ $json._messageId }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendQuery: true,
    queryParameters: {
      parameters: [{ name: '$select', value: GRAPH_SELECT }],
    },
    options: { batching: { batch: { batchSize: 1, batchInterval: 200 } } },
  },
  { position: [1344, 500], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
getMessage.retryOnFail = true;
getMessage.maxTries = 3;
getMessage.waitBetweenTries = 1000;

// 8. Tag Email (Code per item)
const tagEmail = createNode(
  'Tag Email',
  'n8n-nodes-base.code',
  { jsCode: TAG_EMAIL_CODE, mode: 'runOnceForEachItem' },
  { position: [1568, 500], typeVersion: 2 },
);

// 9. Build Contact Query (Code per item)
const buildContactQuery = createNode(
  'Build Contact Query',
  'n8n-nodes-base.code',
  { jsCode: BUILD_CONTACT_QUERY_CODE, mode: 'runOnceForEachItem' },
  { position: [1792, 500], typeVersion: 2 },
);

// 10. Query Contacts (HTTP POST to Notion)
const queryContacts = createNode(
  'Query Contacts',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: '=https://api.notion.com/v1/databases/{{ $json._contactsDbId }}/query',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json._queryBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [2016, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
queryContacts.retryOnFail = true;
queryContacts.maxTries = 3;

// 11. Match Contact (Code per item) — uses back-ref to recover email context
const matchContact = createNode(
  'Match Contact',
  'n8n-nodes-base.code',
  { jsCode: MATCH_CONTACT_CODE, mode: 'runOnceForEachItem' },
  { position: [2240, 500], typeVersion: 2 },
);

// 12. IF: contact matched?
const isContactMatched = createNode(
  'Contact Matched?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'matched-check',
          leftValue: '={{ $json._noMatch }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [2464, 500], typeVersion: 2 },
);

// 13. Emit Pipeline Queries (Code: one input item → 3 output items)
const emitPipelineQueries = createNode(
  'Emit Pipeline Queries',
  'n8n-nodes-base.code',
  { jsCode: EMIT_PIPELINE_QUERIES_CODE, mode: 'runOnceForEachItem' },
  { position: [2688, 500], typeVersion: 2 },
);

// 14. Query Pipeline DB (HTTP POST, fires once per emitted item)
const queryPipelineDb = createNode(
  'Query Pipeline DB',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: '=https://api.notion.com/v1/databases/{{ $json._pipelineDbId }}/query',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json._queryBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [2912, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
queryPipelineDb.retryOnFail = true;
queryPipelineDb.maxTries = 3;

// 15. Merge: combine pipeline-query response (input 0) with the original
// emit output (input 1) so we recover _ctx and _pipelineType per item.
const mergePipelineCtx = createNode(
  'Merge Pipeline + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [3136, 500], typeVersion: 3 },
);

// 16. Aggregate Open Pipelines (Code, runOnceForAllItems) — collapses the 3
// items back into one with {sales:[],partner:[],comms:[]} attached.
const aggregateOpenPipelines = createNode(
  'Aggregate Open Pipelines',
  'n8n-nodes-base.code',
  { jsCode: AGGREGATE_OPEN_PIPELINES_CODE, mode: 'runOnceForAllItems' },
  { position: [3360, 500], typeVersion: 2 },
);

// 17. Build Activity (Code per item)
const buildActivity = createNode(
  'Build Activity',
  'n8n-nodes-base.code',
  { jsCode: BUILD_ACTIVITY_CODE, mode: 'runOnceForEachItem' },
  { position: [3584, 500], typeVersion: 2 },
);

// 18. Create Activity (HTTP POST to Notion)
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
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [3808, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createActivity.retryOnFail = true;
createActivity.maxTries = 3;
createActivity.continueOnFail = true;

// 19. Build LLM Prompt
const buildLlmPrompt = createNode(
  'Build LLM Prompt',
  'n8n-nodes-base.code',
  { jsCode: BUILD_LLM_PROMPT_CODE, mode: 'runOnceForEachItem' },
  { position: [4032, 500], typeVersion: 2 },
);

// 20. Summarize Email (Anthropic)
const summarizeEmail = createNode(
  'Summarize Email',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'anthropic-version', value: '2023-06-01' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.anthropicBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 200 } } },
  },
  { position: [4256, 400], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
summarizeEmail.retryOnFail = true;
summarizeEmail.maxTries = 2;
summarizeEmail.continueOnFail = true;

// 21. Merge Summary + Context (preserves pageId through Anthropic call)
const mergeSummaryContext = createNode(
  'Merge Summary + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [4480, 500], typeVersion: 3 },
);

// 22. Write Summary (Code per item)
const writeSummary = createNode(
  'Write Summary',
  'n8n-nodes-base.code',
  { jsCode: WRITE_SUMMARY_CODE, mode: 'runOnceForEachItem' },
  { position: [4704, 500], typeVersion: 2 },
);

// 23. Update Page Body (HTTP PATCH Notion blocks)
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
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.blocksBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [4928, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
updatePageBody.retryOnFail = true;
updatePageBody.continueOnFail = true;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Email Graph Webhook', {
  nodes: [
    webhook,
    isValidationHandshake,
    respondValidation,
    expandNotifications,
    isClientStateValid,
    respond401,
    respond202,
    hasNotifications,
    getMessage,
    tagEmail,
    buildContactQuery,
    queryContacts,
    matchContact,
    isContactMatched,
    emitPipelineQueries,
    queryPipelineDb,
    mergePipelineCtx,
    aggregateOpenPipelines,
    buildActivity,
    createActivity,
    buildLlmPrompt,
    summarizeEmail,
    mergeSummaryContext,
    writeSummary,
    updatePageBody,
  ],
  connections: [
    // Validation handshake fork
    connect(webhook, isValidationHandshake),
    connect(isValidationHandshake, respondValidation, 0, 0),
    connect(isValidationHandshake, expandNotifications, 1, 0),

    // Notification processing fork: client-state check
    connect(expandNotifications, isClientStateValid),
    // IF condition is "_invalidClientState notEquals true":
    //   output 0 (true)  → clientState OK → 202 and continue processing
    //   output 1 (false) → clientState BAD → 401
    connect(isClientStateValid, respond202, 0, 0),
    connect(isClientStateValid, respond401, 1, 0),

    // After ack, continue with notification items
    connect(respond202, hasNotifications),
    connect(hasNotifications, getMessage, 0, 0),

    // Per-message processing chain
    connect(getMessage, tagEmail),
    connect(tagEmail, buildContactQuery),
    connect(buildContactQuery, queryContacts),
    connect(queryContacts, matchContact),
    connect(matchContact, isContactMatched),

    // Matched → pipeline lookup fork (emit 3 → query → merge with original emit)
    connect(isContactMatched, emitPipelineQueries, 0, 0),
    connect(emitPipelineQueries, queryPipelineDb),
    connect(queryPipelineDb, mergePipelineCtx, 0, 0),
    connect(emitPipelineQueries, mergePipelineCtx, 0, 1),

    // Aggregate → build → create Activity
    connect(mergePipelineCtx, aggregateOpenPipelines),
    connect(aggregateOpenPipelines, buildActivity),
    connect(buildActivity, createActivity),

    // Summarize chain
    connect(createActivity, buildLlmPrompt),
    connect(buildLlmPrompt, summarizeEmail),
    connect(buildLlmPrompt, mergeSummaryContext, 0, 1),
    connect(summarizeEmail, mergeSummaryContext, 0, 0),
    connect(mergeSummaryContext, writeSummary),
    connect(writeSummary, updatePageBody),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
