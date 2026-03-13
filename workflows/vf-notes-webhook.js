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
// Code: Extract text from Notion blocks + prepare summary prompt
// ---------------------------------------------------------------------------
const BUILD_SUMMARY_PROMPT_CODE = `
// $json comes from the Fetch Page Blocks HTTP response.
// The response has a "results" array of block objects.
// We also need the original record from the trigger — access it via
// the 'Execute Workflow Trigger' node.
const trigger = $('Execute Workflow Trigger').first().json;
const record = trigger.record || {};
const body = trigger.body || {};
const entityId = body.entity?.id || '';

const blocks = $json.results || [];

// Extract text content from all block types
function extractText(richTextArray) {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => rt.plain_text || rt.text?.content || '').join('');
}

const lines = [];
for (const block of blocks) {
  const type = block.type;
  if (!type || !block[type]) continue;

  const rt = block[type].rich_text;
  if (rt) {
    const text = extractText(rt);
    if (text) lines.push(text);
  }

  // Handle to_do blocks
  if (type === 'to_do' && block.to_do?.rich_text) {
    const checked = block.to_do.checked ? '[x]' : '[ ]';
    const text = extractText(block.to_do.rich_text);
    if (text) lines.push(checked + ' ' + text);
  }
}

const bodyText = lines.join('\\n').substring(0, 8000); // Cap for Haiku context
const name = record.name || record.property_name || 'Untitled';

if (!bodyText || bodyText.length < 20) {
  // Too short to summarize — pass through with skip flag
  return {
    json: {
      _skipSummary: true,
      _record: record,
      _entityId: entityId,
      _name: name,
    }
  };
}

const prompt = \`Summarize the key points of these account notes in 3-5 concise bullet points. Each bullet should be one sentence. Focus on business relationships, opportunities, and action items. Use plain text only — no markdown, no bold, no asterisks. Keep the total output under 1500 characters.

Account: \${name}

\${bodyText}\`;

const anthropicBody = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 500,
  messages: [{ role: 'user', content: prompt }],
});

return {
  json: {
    _skipSummary: false,
    _record: record,
    _entityId: entityId,
    _name: name,
    anthropicBody,
  }
};
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

// 3. Build Summary Prompt
const buildSummaryPrompt = createNode(
  'Build Summary Prompt',
  'n8n-nodes-base.code',
  { jsCode: BUILD_SUMMARY_PROMPT_CODE, mode: 'runOnceForEachItem' },
  { position: [500, 300], typeVersion: 2 },
);

// 4. Summarize with Haiku
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
  { position: [750, 300], typeVersion: 4.2, credentials: ANTHROPIC_CREDENTIAL },
);
summarize.retryOnFail = true;
summarize.maxTries = 2;
summarize.waitBetweenTries = 1000;
summarize.continueOnFail = true;

// 5. Build Activity Request
const buildActivityRequest = createNode(
  'Build Activity Request',
  'n8n-nodes-base.code',
  { jsCode: BUILD_ACTIVITY_REQUEST_CODE, mode: 'runOnceForEachItem' },
  { position: [1000, 300], typeVersion: 2 },
);

// 6. Create Activity
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
  { position: [1250, 300], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
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
    buildSummaryPrompt,
    summarize,
    buildActivityRequest,
    createActivity,
  ],
  connections: [
    connect(trigger, fetchBlocks),
    connect(fetchBlocks, buildSummaryPrompt),
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
