/**
 * VF Notes Webhook
 *
 * Sub-workflow called by adapter-vf-notes when a VF Notes record is
 * created or updated in Notion. Fetches the note body, summarizes it
 * with Claude Haiku, and creates a new Activity record with the summary.
 *
 * Expects the standard { body, record } payload from the adapter.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTIVITIES_DB_ID = '3178ebaf-15ee-803f-bf71-e30bfc97b2b8';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

const ANTHROPIC_CREDENTIAL = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// ---------------------------------------------------------------------------
// Code: Extract block IDs that have children (need recursive fetch)
// ---------------------------------------------------------------------------
const EXTRACT_CHILD_BLOCK_IDS_CODE = `
const response = $input.first().json;
const blocks = response.results || [];

const output = [];
for (const block of blocks) {
  if (block.has_children) {
    output.push({ json: { blockId: block.id } });
  }
}

// Always output at least one item so the chain continues.
// If no blocks have children, output a sentinel — the HTTP Request will
// fail gracefully (continueOnFail) and Build Summary Prompt handles it.
if (output.length === 0) {
  output.push({ json: { blockId: '_none_', _noChildren: true } });
}

return output;
`;

// ---------------------------------------------------------------------------
// Code: Extract text from Notion blocks (top-level + children) + build prompt
// ---------------------------------------------------------------------------
const BUILD_SUMMARY_PROMPT_CODE = `
// Runs once for ALL items (one item per Fetch Child Blocks response).
// Also pulls top-level blocks and trigger data via node references.
const trigger = $('Execute Workflow Trigger').first().json;
const record = trigger.record || {};
const body = trigger.body || {};
const entityId = body.entity?.id || '';

// Top-level blocks from Fetch Page Blocks
const topLevelBlocks = $('Fetch Page Blocks').first().json.results || [];

// Child block responses — each input item has a .json.results array
const childItems = $input.all();

function extractText(richTextArray) {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => rt.plain_text || rt.text?.content || '').join('');
}

function extractBlockText(block) {
  const type = block.type;
  if (!type || !block[type]) return '';

  // Handle to_do blocks specially (checkbox prefix)
  if (type === 'to_do' && block.to_do?.rich_text) {
    const checked = block.to_do.checked ? '[x]' : '[ ]';
    const text = extractText(block.to_do.rich_text);
    return text ? checked + ' ' + text : '';
  }

  const rt = block[type].rich_text;
  if (rt) return extractText(rt);
  return '';
}

const lines = [];

// 1. Extract text from top-level blocks (headings, paragraphs, etc.)
for (const block of topLevelBlocks) {
  const text = extractBlockText(block);
  if (text) lines.push(text);
}

// 2. Extract text from all fetched child blocks
for (const item of childItems) {
  const childBlocks = item.json?.results || [];
  for (const block of childBlocks) {
    const text = extractBlockText(block);
    if (text) lines.push(text);
  }
}

const bodyText = lines.join('\\n').substring(0, 8000); // Cap for Haiku context
const name = record.name || record.property_name || 'Untitled';

if (!bodyText || bodyText.length < 20) {
  return [{
    json: {
      _skipSummary: true,
      _record: record,
      _entityId: entityId,
      _name: name,
    }
  }];
}

const prompt = \`Summarize the key points of these account notes in 3-5 concise bullet points. Each bullet should be one sentence. Focus on business relationships, opportunities, and action items. Use plain text only — no markdown, no bold, no asterisks. Keep the total output under 1500 characters.

Account: \${name}

\${bodyText}\`;

const anthropicBody = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 500,
  messages: [{ role: 'user', content: prompt }],
});

return [{
  json: {
    _skipSummary: false,
    _record: record,
    _entityId: entityId,
    _name: name,
    anthropicBody,
  }
}];
`;

// ---------------------------------------------------------------------------
// Code: Build Activity creation request from Haiku response + record data
// ---------------------------------------------------------------------------
const BUILD_ACTIVITY_REQUEST_CODE = `
const ACTIVITIES_DB_ID = '${ACTIVITIES_DB_ID}';

// The previous node is Summarize with Haiku, but we need the record data
// which was passed through via the Build Summary Prompt node.
const prev = $('Build Summary Prompt').first().json;
const record = prev._record || {};
const name = prev._name || 'Untitled VF Note';
const skipSummary = prev._skipSummary;

// Extract summary from Anthropic response
let summaryMd = '';
if (!skipSummary && $json.content && Array.isArray($json.content) && $json.content[0]) {
  summaryMd = $json.content[0].text || '';
}

// --- Markdown → Notion rich_text converter ---
// Parses inline **bold** and *italic* into Notion annotation segments.
function mdToRichText(md) {
  const segments = [];
  // Regex: **bold**, *italic*, or plain text
  const re = /(\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|([^*]+))/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    if (m[2]) {
      // **bold**
      segments.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true } });
    } else if (m[3]) {
      // *italic*
      segments.push({ type: 'text', text: { content: m[3] }, annotations: { italic: true } });
    } else if (m[4]) {
      segments.push({ type: 'text', text: { content: m[4] } });
    }
  }
  return segments.length ? segments : [{ type: 'text', text: { content: md } }];
}

// Convert markdown lines to Notion rich_text array (for the Summary property)
// and to children blocks (for the page body).
const lines = summaryMd.split('\\n').filter(l => l.trim());
const richTextSegments = [];
const children = [];

for (const line of lines) {
  const bullet = line.replace(/^[-•*]\\s+/, '');
  const rt = mdToRichText(bullet);

  // Build rich_text property value (flat, with bullet separators)
  if (richTextSegments.length > 0) {
    richTextSegments.push({ type: 'text', text: { content: '\\n' } });
  }
  richTextSegments.push({ type: 'text', text: { content: '• ' } });
  richTextSegments.push(...rt);

  // Build page body as bulleted list items
  children.push({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: rt },
  });
}

// Trim rich_text to stay within Notion's 2000-char property limit
let charCount = 0;
const trimmedRichText = [];
for (const seg of richTextSegments) {
  const content = seg.text.content;
  if (charCount + content.length > 2000) {
    const remaining = 2000 - charCount;
    if (remaining > 0) {
      trimmedRichText.push({ ...seg, text: { content: content.substring(0, remaining) } });
    }
    break;
  }
  trimmedRichText.push(seg);
  charCount += content.length;
}

// Activity date: use the VF Note's last_edited_time
const date = record.property_last_edited_time || new Date().toISOString();

// Relation fields: simplified Notion output gives arrays of page IDs
const salesIds = (record.property_sales_pipeline || []).map(id => ({ id }));
const partnerIds = (record.property_partner_pipeline || []).map(id => ({ id }));

const properties = {
  'Name': {
    title: [{ text: { content: name.substring(0, 100) } }],
  },
  'Type': {
    select: { name: 'Account Note' },
  },
  'Date': {
    date: { start: date },
  },
};

if (salesIds.length > 0) {
  properties['Sales pipeline'] = { relation: salesIds };
}

if (partnerIds.length > 0) {
  properties['Partner pipeline'] = { relation: partnerIds };
}

if (trimmedRichText.length > 0) {
  properties['Summary'] = { rich_text: trimmedRichText };
}

const body = {
  parent: { database_id: ACTIVITIES_DB_ID },
  properties,
};

// Add formatted bullet list to page body if we have a summary
if (children.length > 0) {
  body.children = children;
}

const requestBody = JSON.stringify(body);

return { json: { requestBody } };
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// 1. Execute Workflow Trigger
const trigger = createNode(
  'Execute Workflow Trigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { position: [0, 300], typeVersion: 1.1 },
);

// 2. Fetch Page Blocks — get VF Note body content
const fetchBlocks = createNode(
  'Fetch Page Blocks',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: '=https://api.notion.com/v1/blocks/{{ $json.body.entity.id }}/children?page_size=100',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Notion-Version', value: '2022-06-28' },
      ],
    },
    options: {},
  },
  { position: [250, 300], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
fetchBlocks.retryOnFail = true;
fetchBlocks.maxTries = 3;
fetchBlocks.waitBetweenTries = 1000;

// 3. Extract Child Block IDs — identify blocks that need child fetching
const extractChildBlockIds = createNode(
  'Extract Child Block IDs',
  'n8n-nodes-base.code',
  { jsCode: EXTRACT_CHILD_BLOCK_IDS_CODE, mode: 'runOnceForAllItems' },
  { position: [500, 300], typeVersion: 2 },
);

// 4. Fetch Child Blocks — get content inside toggleable headings
const fetchChildBlocks = createNode(
  'Fetch Child Blocks',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: '=https://api.notion.com/v1/blocks/{{ $json.blockId }}/children?page_size=100',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Notion-Version', value: '2022-06-28' },
      ],
    },
    options: {},
  },
  { position: [750, 300], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
fetchChildBlocks.continueOnFail = true;
fetchChildBlocks.retryOnFail = true;
fetchChildBlocks.maxTries = 3;
fetchChildBlocks.waitBetweenTries = 1000;

// 5. Build Summary Prompt — aggregate top-level + child block text
const buildSummaryPrompt = createNode(
  'Build Summary Prompt',
  'n8n-nodes-base.code',
  { jsCode: BUILD_SUMMARY_PROMPT_CODE, mode: 'runOnceForAllItems' },
  { position: [1000, 300], typeVersion: 2 },
);

// 6. Summarize with Haiku
const summarize = createNode(
  'Summarize with Haiku',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
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
  { position: [1250, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
summarize.retryOnFail = true;
summarize.maxTries = 2;
summarize.waitBetweenTries = 1000;
summarize.continueOnFail = true;

// 7. Build Activity Request
const buildActivityRequest = createNode(
  'Build Activity Request',
  'n8n-nodes-base.code',
  { jsCode: BUILD_ACTIVITY_REQUEST_CODE, mode: 'runOnceForEachItem' },
  { position: [1500, 300], typeVersion: 2 },
);

// 8. Create Activity
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
  { position: [1750, 300], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createActivity.retryOnFail = true;
createActivity.maxTries = 3;
createActivity.waitBetweenTries = 1000;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export default createWorkflow('VF Notes Webhook', {
  nodes: [
    trigger,
    fetchBlocks,
    extractChildBlockIds,
    fetchChildBlocks,
    buildSummaryPrompt,
    summarize,
    buildActivityRequest,
    createActivity,
  ],
  connections: [
    connect(trigger, fetchBlocks),
    connect(fetchBlocks, extractChildBlockIds),
    connect(extractChildBlockIds, fetchChildBlocks),
    connect(fetchChildBlocks, buildSummaryPrompt),
    connect(buildSummaryPrompt, summarize),
    connect(summarize, buildActivityRequest),
    connect(buildActivityRequest, createActivity),
  ],
  active: false,
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
    callerPolicy: 'workflowsFromSameOwner',
  },
});
