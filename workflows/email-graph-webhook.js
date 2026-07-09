/**
 * Email Graph Webhook
 *
 * Receives Microsoft Graph change notifications for Eve's inbox and sent
 * items, then for each new message:
 *   1. Fetches the full message from Graph
 *   2. Matches sender (received) or recipients (sent) to a Notion contact
 *   3. Looks up the contact's pipeline items in Sales / Partner / Comms
 *      (all except lost/cancelled deals)
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

// Addresses that belong to Eve (the mailbox owner) and must NOT be treated as
// candidate contacts — otherwise every received email would "match Eve" via
// the To header. Both primary and forwarding/personal aliases are listed.
const OWNER_EMAILS = ['eve@vennfactory.com', 'eve@xmlgrrl.com'];

// excludedStatuses = genuinely dead deals (lost/cancelled) that an email
// activity should NOT link to. Won/completed/confirmed deals are considered
// active relationships and DO link — the contact keeps corresponding about
// signed work, aired podcasts, confirmed talks, etc.
const PIPELINES = {
  sales: {
    dbId: '2ed21e43d3a545f48cf4a2a8f61a264f',
    relationProp: 'Sales pipeline',
    excludedStatuses: ['Lost/rejected'],
  },
  partner: {
    dbId: '457cfa4c123b4718a7d3c8bf7ea4a27e',
    relationProp: 'Partner pipeline',
    excludedStatuses: ['Lost/rejected'],
  },
  comms: {
    dbId: '35d10c8392e64ce2adc28c03e2c97480',
    relationProp: 'Comms pipeline',
    excludedStatuses: ['Rejected/Cancelled'],
  },
};

// internetMessageHeaders is only returned when explicitly requested via $select.
// We use it in Tag Email to short-circuit mailing-list mail.
const GRAPH_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,parentFolderId,internetMessageHeaders';

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

// Mailing-list detection — any of these SMTP headers reliably indicate the
// message came from a list/bulk sender, so we short-circuit instead of
// trying to match the sender to a contact and create an Activity record.
const headers = email.internetMessageHeaders || [];
const headerMap = {};
for (const h of headers) {
  if (h && h.name) headerMap[h.name.toLowerCase()] = String(h.value || '');
}
const isMailingList =
  !!headerMap['list-id'] ||
  !!headerMap['list-unsubscribe'] ||
  !!headerMap['list-unsubscribe-post'] ||
  !!headerMap['x-mailing-list'] ||
  !!headerMap['x-list-subscribe'] ||
  /^(bulk|list|junk|auto[_-]?reply)$/i.test(headerMap['precedence'] || '');

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
    _isMailingList: isMailingList,
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
// Code: build a Notion contacts-DB query body for the email's match candidates.
// Candidates = every address in from + to + cc (regardless of direction),
// excluding the mailbox owner's own addresses, deduplicated.
// ---------------------------------------------------------------------------
const BUILD_CONTACT_QUERY_CODE = `
const CONTACTS_DB_ID = ${JSON.stringify(CONTACTS_DB_ID)};
const OWNER = new Set(${JSON.stringify(OWNER_EMAILS.map(s => s.toLowerCase()))});
const j = $json;

const all = [
  j._fromAddress,
  ...(j._toAddresses || []),
  ...(j._ccAddresses || []),
];
const candidates = Array.from(new Set(
  all.map(a => (a || '').toLowerCase()).filter(a => a && !OWNER.has(a))
));

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
  // Page size set comfortably above the typical 1-3 candidates per email;
  // the OR filter returns at most one page per matching Identifier.
  page_size: 25,
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
// Code: find EVERY contact whose Identifier matches any candidate address,
// and collect the union of their pipeline relations (deduplicated by page ID).
// Each matched contact contributes its Sales/Partner/Comms pipeline relations
// to the union; the downstream Get Pipeline Page chain checks each one's
// Status to filter out lost/cancelled opportunities.
// ---------------------------------------------------------------------------
const MATCH_CONTACT_CODE = `
const ctx = $('Build Contact Query').item.json;
const results = ($json.results || []);

// Index full page objects by lowercased Identifier email.
const byEmail = new Map();
for (const page of results) {
  const titleProp = page.properties && page.properties.Identifier && page.properties.Identifier.title;
  const email = (titleProp && titleProp[0] && titleProp[0].plain_text || '').toLowerCase();
  if (email) byEmail.set(email, page);
}

// Collect ALL matched contacts (not just the first) across all candidates.
const candidates = ctx._candidates || [];
const matchedEmails = [];
const matchedContactIds = [];
const seenContactIds = new Set();
const matchedPages = [];
for (const addr of candidates) {
  const page = byEmail.get(addr);
  if (!page || !page.id) continue;
  if (seenContactIds.has(page.id)) continue;  // same contact reached via multiple addresses → dedupe
  seenContactIds.add(page.id);
  matchedEmails.push(addr);
  matchedContactIds.push(page.id);
  matchedPages.push(page);
}

if (matchedContactIds.length === 0) {
  return { json: { ...ctx, _noMatch: true } };
}

// Union the pipeline relations across every matched contact, deduped by
// pageId so two contacts sharing a deal contribute it only once.
function readRelation(props, name) {
  const p = props && props[name];
  return (p && Array.isArray(p.relation)) ? p.relation.map(r => r.id).filter(Boolean) : [];
}

const seenPipelinePages = new Set();
const relatedPipelines = [];
for (const page of matchedPages) {
  const props = page.properties || {};
  for (const [type, propName] of [['sales', 'Sales pipeline'], ['partner', 'Partner pipeline'], ['comms', 'Comms pipeline']]) {
    for (const pageId of readRelation(props, propName)) {
      const key = type + ':' + pageId;
      if (seenPipelinePages.has(key)) continue;
      seenPipelinePages.add(key);
      relatedPipelines.push({ type, pageId });
    }
  }
}

return {
  json: {
    ...ctx,
    _matchedEmails: matchedEmails,
    _matchedContactIds: matchedContactIds,
    _relatedPipelines: relatedPipelines,
  },
};
`;

// ---------------------------------------------------------------------------
// Code: fan out one item per related pipeline page (already known from the
// matched contact's relation arrays). When the contact has NO related
// pipeline items, emit a single _skipFetch sentinel that bypasses the pipeline
// GET and proceeds straight to Build Activity with empty open lists.
// ---------------------------------------------------------------------------
const EMIT_PIPELINE_REFS_CODE = `
const out = [];

for (const item of $input.all()) {
  const ctx = item.json;
  if (!ctx || !ctx._matchedContactIds || ctx._matchedContactIds.length === 0) continue;
  const refs = ctx._relatedPipelines || [];
  if (refs.length === 0) {
    out.push({ json: { _ctx: ctx, _skipFetch: true } });
    continue;
  }
  for (const ref of refs) {
    out.push({
      json: {
        _ctx: ctx,
        _pipelineType: ref.type,
        _pipelinePageId: ref.pageId,
      },
    });
  }
}

if (out.length === 0) {
  return [{ json: { _empty: true } }];
}
return out;
`;

// ---------------------------------------------------------------------------
// Code: aggregate the per-pipeline-page Notion responses into one open-items
// map per email. Each input item is a Notion page object paired with
// _ctx + _pipelineType via the upstream Merge (combineByPosition). The
// _skipFetch sentinel (no related pipelines for this contact) is also handled
// here and yields empty open lists.
// ---------------------------------------------------------------------------
const PIPELINE_EXCLUDED_STATUSES = {
  sales: PIPELINES.sales.excludedStatuses,
  partner: PIPELINES.partner.excludedStatuses,
  comms: PIPELINES.comms.excludedStatuses,
};
const AGGREGATE_OPEN_PIPELINES_CODE = `
const EXCLUDED = ${JSON.stringify(PIPELINE_EXCLUDED_STATUSES)};
const items = $input.all();

// Group items by the email they belong to (keyed by _messageId on _ctx).
const byEmail = new Map();
for (const item of items) {
  const j = item.json;
  const ctx = j._ctx;
  if (!ctx) continue;
  const key = ctx._messageId;
  if (!byEmail.has(key)) {
    byEmail.set(key, { ctx, open: { sales: [], partner: [], comms: [] } });
  }
  if (j._skipFetch) continue;

  // Read Status — could be a 'status' or 'select' type. Try both.
  const props = j.properties || {};
  const statusProp = props.Status || {};
  const statusName = (statusProp.status && statusProp.status.name) ||
                     (statusProp.select && statusProp.select.name) || '';

  const type = j._pipelineType;
  if (!type || !EXCLUDED[type]) continue;
  if (EXCLUDED[type].includes(statusName)) continue;  // lost/cancelled → skip

  const bucket = byEmail.get(key);
  if (j.id) bucket.open[type].push(j.id);
}

if (byEmail.size === 0) {
  return [{ json: { _noContext: true } }];
}

const out = [];
for (const { ctx, open } of byEmail.values()) {
  out.push({ json: { ...ctx, _openPipelines: open } });
}
return out;
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
  // Render in US Central (America/Chicago) — DST (CDT/CST) handled automatically.
  // formatToParts converts the whole date+time, so late-UTC emails also land on
  // the correct Central calendar day.
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return p.month + '-' + p.day + '-' + p.year + ' ' + p.hour + ':' + p.minute;   // MM-DD-YYYY HH:MM (US Central)
}

function cleanSubject(subject) {
  return (subject || '').replace(/^(Re|Fwd?|FW|AW|TR):\\s*/i, '').trim() || '(no subject)';
}

const emailType = j._direction === 'sent' ? 'Email Sent' : 'Email Received';
// Compact name so the subject leads and isn't truncated:
//   {↑ sent | ↓ received} {source} {MM-DD-YYYY HH:MM} · {full subject}
// The arrow + source keep the disambiguators tiny (~27-char prefix) versus the
// old 'Email Sent · <full ISO> · ' prefix that pushed the subject off-screen.
const arrow = j._direction === 'sent' ? '↑' : '↓';
const source = 'Email';
const activityName = (arrow + ' ' + source + ' ' + formatEmailDatetime(j._date) + ' · ' + cleanSubject(j._subject)).substring(0, 120);

// Activities DB schema: Name, Type, Direction, Date, Subject, Summary,
// Contact, Sales/Partner/Comms pipeline. The Summary property holds the
// AI-generated summary (set only when _aiSummary is non-empty — short or
// empty bodies skip the LLM and leave Summary unset).
const properties = {
  'Name': { title: [{ text: { content: activityName } }] },
  'Type': { select: { name: emailType } },
  'Direction': { select: { name: j._direction === 'sent' ? 'Sent' : 'Received' } },
  'Date': { date: { start: j._date } },
  'Subject': { rich_text: [{ text: { content: (j._subject || '').substring(0, 200) } }] },
  'Contact': { relation: (j._matchedContactIds || []).map(id => ({ id })) },
};

if (j._aiSummary) {
  properties['Summary'] = { rich_text: [{ text: { content: j._aiSummary.substring(0, 2000) } }] };
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
// Code: build the Anthropic prompt from the upstream email body. Runs BEFORE
// Create Activity so the AI summary can be written into the Summary property
// in a single Notion create call (no PATCH, no second activity-webhook fire).
// Preserves the full upstream ctx by spreading $json.
// ---------------------------------------------------------------------------
const BUILD_LLM_PROMPT_CODE = `
const item = $json;

// Strip quoted reply/forward chains so the summary reflects only THIS message,
// not every prior email in the thread. The HTML has already been flattened to a
// single whitespace-collapsed line, so we cut at the earliest quote marker.
function stripQuoted(text) {
  if (!text) return '';
  const markers = [
    /\\bOn\\b[\\s\\S]{0,200}?\\bwrote:/,       // "On <date>, <name> wrote:"
    /\\bFrom:\\s[\\s\\S]{0,120}?\\bSent:\\s/,   // Outlook "From: … Sent: …" header
    /-{3,}\\s*Original Message\\s*-{3,}/i,    // "-----Original Message-----"
    /\\bBegin forwarded message:/i,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index >= 0 && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

const body = stripQuoted(item._bodyText || '');
const subject = item._subject || '';

// Too short to summarize meaningfully (or a pure-quote reply with no new text)
// → skip the LLM, mark for the IF gate. _aiSummary stays empty so Build
// Activity omits the Summary property.
if (!body || body.length < 20) {
  return { json: { ...item, anthropicBody: '{}', _skipSummary: true, _aiSummary: '' } };
}

const prompt = \`Summarize the key points of this email in 2-3 concise bullet points. Each bullet should be one sentence. Do not include greetings, sign-offs, or boilerplate.

Subject: \${subject}

\${body}\`;

const anthropicBody = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 300,
  messages: [{ role: 'user', content: prompt }],
});

return { json: { ...item, anthropicBody, _skipSummary: false, _aiSummary: '' } };
`;

// ---------------------------------------------------------------------------
// Code: extract Claude's summary text from the merged response and stash it
// in _aiSummary. Build Activity downstream reads this to populate the Summary
// property. (Replaces the old Write Summary / Update Page Body chain — the
// summary now lives in the property instead of page-body blocks.)
// ---------------------------------------------------------------------------
const EXTRACT_SUMMARY_CODE = `
const item = $json;
let aiSummary = '';
if (item.content && Array.isArray(item.content) && item.content[0]) {
  aiSummary = item.content[0].text || '';
}
return { json: { ...item, _aiSummary: aiSummary } };
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

// 6. Filter: any notifications to process? (drops the _empty / sentinel items
// emitted by Expand Notifications when nothing actionable arrived).
const hasNotifications = createNode(
  'Has Notifications',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
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
    options: {},
  },
  { position: [1120, 500], typeVersion: 2.2 },
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
// Graph notifications routinely carry stale message IDs: by the time we GET
// the message, Outlook may have moved it (junk filter, inbox rule) or deleted
// it, and Graph returns 404. Route errors to a secondary output we filter
// down to true 404s, so we drop those silently while letting other Graph
// failures (auth, rate limit, 5xx) still surface via the error workflow.
getMessage.onError = 'continueErrorOutput';

// 7b. Filter: drop Graph 404s on the error output. The Graph notification
// carried an ID that no longer resolves (message moved or deleted). Non-404
// errors continue to the Stop and Error below so the error workflow fires.
const notGraph404 = createNode(
  'Not Graph 404',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'is-404-check',
          leftValue: '={{ $json.error.cause.status }}',
          rightValue: 404,
          operator: { type: 'number', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1568, 700], typeVersion: 2.2 },
);

// 7c. Stop and Error — surfaces non-404 Graph fetch failures to the error
// workflow rather than silently swallowing them.
const stopOnGraphError = createNode(
  'Stop on Graph Error',
  'n8n-nodes-base.stopAndError',
  {
    errorMessage: '={{ "Microsoft Graph fetch failed: " + ($json.error.message || "unknown") }}',
  },
  { position: [1792, 700], typeVersion: 1 },
);

// 8. Tag Email (Code per item)
const tagEmail = createNode(
  'Tag Email',
  'n8n-nodes-base.code',
  { jsCode: TAG_EMAIL_CODE, mode: 'runOnceForEachItem' },
  { position: [1568, 500], typeVersion: 2 },
);

// 8b. Filter: drop mailing-list messages (List-Id / List-Unsubscribe /
// Precedence: bulk|list headers). We don't create Activity records for
// newsletters, marketing blasts, etc.
const notMailingList = createNode(
  'Not Mailing List',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'mailing-list-check',
          leftValue: '={{ $json._isMailingList }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1792, 500], typeVersion: 2.2 },
);

// 9. Build Contact Query (Code per item)
const buildContactQuery = createNode(
  'Build Contact Query',
  'n8n-nodes-base.code',
  { jsCode: BUILD_CONTACT_QUERY_CODE, mode: 'runOnceForEachItem' },
  { position: [2016, 500], typeVersion: 2 },
);

// 9b. Filter: drop emails with no external candidate addresses. When the only
// addresses on the message are the mailbox owner's own (e.g. self-addressed or
// spoofed mail), Build Contact Query sets _noCandidates and leaves _queryBody
// unset — without this gate those items hit Query Contacts with an undefined
// JSON body and fail with "JSON parameter needs to be valid JSON".
const hasCandidates = createNode(
  'Has Candidates',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'has-candidates-check',
          leftValue: '={{ $json._noCandidates }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2128, 500], typeVersion: 2.2 },
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
  { position: [2240, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
queryContacts.retryOnFail = true;
queryContacts.maxTries = 3;

// 11. Match Contact (Code per item) — uses back-ref to recover email context
const matchContact = createNode(
  'Match Contact',
  'n8n-nodes-base.code',
  { jsCode: MATCH_CONTACT_CODE, mode: 'runOnceForEachItem' },
  { position: [2464, 500], typeVersion: 2 },
);

// 12. Filter: drop items where no contact was matched.
const contactMatched = createNode(
  'Contact Matched',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
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
    options: {},
  },
  { position: [2688, 500], typeVersion: 2.2 },
);

// 13a. Has Pipelines? — splits emitPipelineRefs output. Items with a
// _pipelinePageId go to the GET path; _skipFetch sentinels bypass it.
const hasPipelinePage = createNode(
  'Has Pipeline Page?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'has-pp-check',
          leftValue: '={{ $json._pipelinePageId }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [3136, 500], typeVersion: 2 },
);

// 13. Emit Pipeline Refs (Code: one input item → N output items, one per
// related pipeline page on the matched contact. Emits a _skipFetch sentinel
// when the contact has no related pipeline items.)
const emitPipelineRefs = createNode(
  'Emit Pipeline Refs',
  'n8n-nodes-base.code',
  { jsCode: EMIT_PIPELINE_REFS_CODE, mode: 'runOnceForAllItems' },
  { position: [2912, 500], typeVersion: 2 },
);

// 14. Get Pipeline Page (HTTP GET — fetches one Notion page per emitted ref
// so we can read its Status. Items with _skipFetch:true bypass the URL
// substitution by sending to a no-op endpoint... actually we filter those
// out with the Has Pipelines? IF below and re-merge them at Aggregate.)
const getPipelinePage = createNode(
  'Get Pipeline Page',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: '=https://api.notion.com/v1/pages/{{ $json._pipelinePageId }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Notion-Version', value: '2022-06-28' }],
    },
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [3360, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
getPipelinePage.retryOnFail = true;
getPipelinePage.maxTries = 3;

// 15. Merge: combine pipeline-page response (input 0) with the original
// emit output (input 1) so we recover _ctx and _pipelineType per item.
const mergePipelineCtx = createNode(
  'Merge Pipeline + Context',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [3584, 500], typeVersion: 3 },
);

// 16. Aggregate Open Pipelines (Code, runOnceForAllItems) — collapses the per-
// pipeline items back into one per email, with {sales:[],partner:[],comms:[]}
// attached. Also accepts _skipFetch sentinels (no-pipeline emails) directly.
const aggregateOpenPipelines = createNode(
  'Aggregate Open Pipelines',
  'n8n-nodes-base.code',
  { jsCode: AGGREGATE_OPEN_PIPELINES_CODE, mode: 'runOnceForAllItems' },
  { position: [3808, 500], typeVersion: 2 },
);

// 17. Build LLM Prompt (Code per item) — runs BEFORE Create Activity so the
// AI summary can be written into the Summary property at create time. Reads
// _bodyText from upstream ctx and preserves the whole ctx by spreading $json.
const buildLlmPrompt = createNode(
  'Build LLM Prompt',
  'n8n-nodes-base.code',
  { jsCode: BUILD_LLM_PROMPT_CODE, mode: 'runOnceForEachItem' },
  { position: [4032, 500], typeVersion: 2 },
);

// 18. Summary Worthy? — IF gate (two branches both used):
//   - True  (output 0): substantive body → call Anthropic
//   - False (output 1): short / empty body → skip directly to Build Activity
//     (no Summary property gets set on the Activity)
const summaryWorthy = createNode(
  'Summary Worthy?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { typeValidation: 'strict' },
      conditions: [
        {
          id: 'worthy-check',
          leftValue: '={{ $json._skipSummary }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals', singleValue: false },
        },
      ],
      combinator: 'and',
    },
  },
  { position: [4256, 500], typeVersion: 2 },
);

// 19. Summarize Email (Anthropic) — fork: response → Merge input 0, original
// ctx passthrough → Merge input 1.
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
  { position: [4480, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
summarizeEmail.retryOnFail = true;
summarizeEmail.maxTries = 2;
// continueOnFail so a transient Anthropic 5xx still lets the Activity get
// created (just without a Summary). Extract Summary downstream handles the
// error-shaped item by leaving _aiSummary empty.
summarizeEmail.continueOnFail = true;

// 20. Merge Claude + Ctx (combineByPosition) — recovers ctx after Summarize
// replaces $json with the Claude response.
const mergeClaudeCtx = createNode(
  'Merge Claude + Ctx',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [4704, 500], typeVersion: 3 },
);

// 21. Extract Summary — pulls Claude's content[0].text into _aiSummary.
const extractSummary = createNode(
  'Extract Summary',
  'n8n-nodes-base.code',
  { jsCode: EXTRACT_SUMMARY_CODE, mode: 'runOnceForEachItem' },
  { position: [4928, 500], typeVersion: 2 },
);

// 22. Build Activity (Code per item) — runs on items from BOTH paths:
//   - Extract Summary → has _aiSummary set
//   - Summary Worthy? false → has _aiSummary = ''
// Build Activity conditionally includes the Summary property based on _aiSummary.
const buildActivity = createNode(
  'Build Activity',
  'n8n-nodes-base.code',
  { jsCode: BUILD_ACTIVITY_CODE, mode: 'runOnceForEachItem' },
  { position: [5152, 500], typeVersion: 2 },
);

// 23. Create Activity (HTTP POST to Notion) — single write per email,
// includes Summary in the same call when applicable.
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
  { position: [5376, 500], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createActivity.retryOnFail = true;
createActivity.maxTries = 3;
// No continueOnFail: if the Activity create fails, fire the error workflow.

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
    notGraph404,
    stopOnGraphError,
    tagEmail,
    notMailingList,
    buildContactQuery,
    hasCandidates,
    queryContacts,
    matchContact,
    contactMatched,
    emitPipelineRefs,
    hasPipelinePage,
    getPipelinePage,
    mergePipelineCtx,
    aggregateOpenPipelines,
    buildLlmPrompt,
    summaryWorthy,
    summarizeEmail,
    mergeClaudeCtx,
    extractSummary,
    buildActivity,
    createActivity,
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
    connect(hasNotifications, getMessage),

    // Per-message processing chain. Filter nodes silently drop items that
    // fail the condition (mailing-list mail, unknown sender), so execution
    // simply ends for those items with no downstream side-effects.
    connect(getMessage, tagEmail, 0, 0),
    // Get Message error output (output 1): 404s drop silently, everything
    // else hits Stop and Error → error workflow fires.
    connect(getMessage, notGraph404, 1, 0),
    connect(notGraph404, stopOnGraphError),
    connect(tagEmail, notMailingList),
    connect(notMailingList, buildContactQuery),
    connect(buildContactQuery, hasCandidates),
    connect(hasCandidates, queryContacts),
    connect(queryContacts, matchContact),
    connect(matchContact, contactMatched),

    // Matched → emit refs → split (skip-fetch sentinels bypass the GET)
    connect(contactMatched, emitPipelineRefs),
    connect(emitPipelineRefs, hasPipelinePage),

    // Has Pipeline Page? true → fork: GET + passthrough → Merge → Aggregate
    connect(hasPipelinePage, getPipelinePage, 0, 0),
    connect(hasPipelinePage, mergePipelineCtx, 0, 1),
    connect(getPipelinePage, mergePipelineCtx, 0, 0),
    connect(mergePipelineCtx, aggregateOpenPipelines),

    // Has Pipeline Page? false (_skipFetch sentinel) → straight to Aggregate
    connect(hasPipelinePage, aggregateOpenPipelines, 1, 0),

    // Aggregate → LLM prompt → branch on whether to summarize
    connect(aggregateOpenPipelines, buildLlmPrompt),
    connect(buildLlmPrompt, summaryWorthy),

    // Summary Worthy? TRUE (output 0): call Anthropic, then merge ctx back
    connect(summaryWorthy, summarizeEmail, 0, 0),
    connect(summaryWorthy, mergeClaudeCtx, 0, 1),
    connect(summarizeEmail, mergeClaudeCtx, 0, 0),
    connect(mergeClaudeCtx, extractSummary),
    connect(extractSummary, buildActivity),

    // Summary Worthy? FALSE (output 1): skip the LLM, go straight to build
    // (Build Activity sees _aiSummary='' and omits the Summary property)
    connect(summaryWorthy, buildActivity, 1, 0),

    // Single write to Notion with everything (including Summary when set)
    connect(buildActivity, createActivity),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
