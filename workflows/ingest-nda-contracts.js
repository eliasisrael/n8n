/**
 * Ingest NDA Contracts — Dropbox → Notion
 *
 * Watches each client's Contracts folder in the Venn Factory account tree,
 * extracts the key terms from any new executed NDA, and creates a record in
 * the Notion NDAs database.
 *
 * Dropbox layout:
 *   /Filing Cabinet/*Venn Factory/VF accts/<account name>/Contracts/   ← EXECUTED (processed)
 *   /Filing Cabinet/*Venn Factory/VF accts/<account name>/Contracts/<sub>/  ← drafts (ignored)
 *
 * Only files sitting DIRECTLY in `Contracts` are treated as executed. Drafts
 * live in subfolders, and we never descend: the Dropbox folder list is
 * non-recursive, and "Filter: PDFs Only" additionally drops folder entries.
 * The `*` in `*Venn Factory` is a literal character, not a glob; `VF accts` has none.
 *
 * The account folder name gives us the client, so the counterparty does not
 * have to be guessed from the document. The model still supplies the formal
 * legal entity (the signature block often differs from the folder name).
 *
 * DRY RUN IS THE DEFAULT. `Config.dryRun = true` reports what WOULD be created
 * and writes nothing. Flip it to false once the first pass looks right — the
 * first real run will otherwise ingest every contract already on disk.
 *
 * Dedup: the Dropbox web link is stored in the NDAs `NDA file` URL property and
 * used as the per-file key. It cannot be the counterparty or the title, because
 * `Superseded by` implies a company can have several NDAs over time.
 *
 * Relations: the account name is looked up in Clients first, then Partners. If
 * neither matches, the record is still created with both relations empty rather
 * than dropped. `Superseded by` is deliberately never set — deciding which
 * agreement replaces which is a legal judgement, not something to infer.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// NOTE the asymmetry: '*Venn Factory' carries a literal '*', 'VF accts' does not.
const ACCOUNTS_ROOT = '/Filing Cabinet/*Venn Factory/VF accts';
const CONTRACTS_SUBFOLDER = 'Contracts';

const NDA_DB_ID = '2378ebaf-15ee-8091-a178-e6cfda664c4e';
const CLIENTS_DB_ID = '39b8f7e7-362f-4121-8389-4d9f5c26c1d4';
const PARTNERS_DB_ID = '642b44e9-1363-4765-aaaf-702a708d6812';

const EXTRACTION_MODEL = 'claude-sonnet-5';

const DROPBOX_CREDENTIAL = {
  dropboxOAuth2Api: { id: '5p74zyJBc4pRsoO4', name: 'Dropbox account' },
};
const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};
const ANTHROPIC_HEADER_AUTH = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

const EXTRACTION_PROMPT = [
  'You are extracting key terms from an executed non-disclosure agreement (NDA).',
  '"We"/"us" refers to Venn Factory (also written VF or Venn Factory LLC).',
  'The other signing party is the counterparty.',
  '',
  'Call the record_nda tool exactly once. Rules:',
  '- Quote the agreement. Do not infer or invent terms that are not present.',
  '- If a field is genuinely absent from the document, return an empty string',
  '  (or null for effective_date). Do NOT guess.',
  '- effective_date must be YYYY-MM-DD. If the agreement is dated only by',
  '  signature, use the LATEST signature date. If no date is present, null.',
  '- my_form is "Yes" only if this is clearly Venn Factory\'s own template',
  '  (e.g. VF is named first/as "Company", or VF branding/footers appear).',
  '  If it is plainly the counterparty\'s paper, "No". If unclear, "No".',
  '- expired is "Yes" only if the term has demonstrably already ended as of',
  '  today. If the term is open-ended, survives, or you cannot tell, "No".',
  '- term and post_termination_period should be quoted compactly, e.g.',
  '  "3 years from Effective Date", "perpetual for trade secrets, 5 years otherwise".',
].join('\n');

// The tool schema forces well-shaped JSON back, so no response parsing is
// needed — the fields are read straight off the tool_use block.
const EXTRACTION_TOOL = {
  name: 'record_nda',
  description: 'Record the key terms extracted from an executed NDA.',
  input_schema: {
    type: 'object',
    properties: {
      counterparty_legal_name: { type: 'string', description: 'Formal legal entity of the counterparty as written in the signature block, e.g. "Acme Corporation, Inc."' },
      effective_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if absent' },
      term: { type: 'string' },
      post_termination_period: { type: 'string', description: 'How long confidentiality obligations survive termination' },
      governing_law: { type: 'string', description: 'Governing law, e.g. "Delaware"' },
      venue: { type: 'string', description: 'Venue / forum for disputes' },
      special_provisions: { type: 'string', description: 'Notable non-standard terms; empty string if none' },
      auto_renew: { type: 'string', enum: ['Yes', 'No'] },
      my_form: { type: 'string', enum: ['Yes', 'No'] },
      expired: { type: 'string', enum: ['Yes', 'No'] },
    },
    required: [
      'counterparty_legal_name', 'effective_date', 'term', 'post_termination_period',
      'governing_law', 'venue', 'special_provisions', 'auto_renew', 'my_form', 'expired',
    ],
  },
};

// ---------------------------------------------------------------------------
// Code: assemble the Notion create payload (pure in-memory JSON/string work —
// no HTTP and no binary, which is the only sanctioned use of a Code node here).
// Resolving the Client/Partner relation is a plain lookup against the two
// already-fetched page lists, so it costs no extra API calls per contract.
// ---------------------------------------------------------------------------
const BUILD_REQUEST_CODE = `
const NDA_DB_ID = ${JSON.stringify(NDA_DB_ID)};

// Notion page titles surface under different keys depending on the property
// name, so probe defensively rather than assuming one shape.
function titleOf(page) {
  const j = page.json || {};
  if (typeof j.name === 'string' && j.name) return j.name;
  for (const [k, v] of Object.entries(j)) {
    if (!k.startsWith('property_')) continue;
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0]) return v[0];
  }
  return '';
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function findPage(pages, accountName) {
  const want = norm(accountName);
  if (!want) return null;
  let hit = pages.find(p => norm(titleOf(p)) === want);
  if (hit) return hit;
  // Fall back to a containment match so "Acme" finds "Acme Corporation".
  hit = pages.find(p => {
    const t = norm(titleOf(p));
    return t && (t.includes(want) || want.includes(t));
  });
  return hit || null;
}

let clients = [], partners = [];
try { clients = $('Get Clients').all(); } catch (e) {}
try { partners = $('Get Partners').all(); } catch (e) {}

const out = [];
for (const item of $input.all()) {
  const j = item.json || {};
  const tool = (j.content || []).find(c => c && c.type === 'tool_use');
  const nda = (tool && tool.input) || {};

  const accountName = j.accountName || '';
  const counterparty = nda.counterparty_legal_name || accountName;

  // Clients first, then Partners.
  const client = findPage(clients, accountName);
  const partner = client ? null : findPage(partners, accountName);

  const text = (v) => [{ text: { content: String(v || '').substring(0, 2000) } }];
  const properties = {
    '"<co> NDA"': { title: text(accountName + ' NDA') },
    'Counterparty': { rich_text: text(counterparty) },
    'NDA file': { url: j.ndaUrl || null },
    'Term': { rich_text: text(nda.term) },
    'Post-termination period': { rich_text: text(nda.post_termination_period) },
    'Governing law': { rich_text: text(nda.governing_law) },
    'Venue': { rich_text: text(nda.venue) },
    'Special provisions': { rich_text: text(nda.special_provisions) },
    'Auto-renew?': { select: { name: nda.auto_renew === 'Yes' ? 'Yes' : 'No' } },
    'My form?': { select: { name: nda.my_form === 'Yes' ? 'Yes' : 'No' } },
    'Expired?': { select: { name: nda.expired === 'Yes' ? 'Yes' : 'No' } },
  };

  // Only send a date when we actually have one — Notion rejects a malformed date.
  if (nda.effective_date && /^\\d{4}-\\d{2}-\\d{2}$/.test(nda.effective_date)) {
    properties['Effective date'] = { date: { start: nda.effective_date } };
  }
  if (client) properties['Client record'] = { relation: [{ id: client.json.id }] };
  if (partner) properties['Partner record'] = { relation: [{ id: partner.json.id }] };

  out.push({
    json: {
      // Flat preview fields — this is what the dry run prints.
      account: accountName,
      file: j.filePath,
      counterparty,
      effective_date: nda.effective_date || null,
      term: nda.term || '',
      governing_law: nda.governing_law || '',
      venue: nda.venue || '',
      post_termination_period: nda.post_termination_period || '',
      special_provisions: nda.special_provisions || '',
      auto_renew: nda.auto_renew,
      my_form: nda.my_form,
      expired: nda.expired,
      linked_to: client ? 'Client: ' + titleOf(client) : (partner ? 'Partner: ' + titleOf(partner) : 'NONE — link by hand'),
      ndaUrl: j.ndaUrl,
      requestBody: JSON.stringify({ parent: { database_id: NDA_DB_ID }, properties }),
    },
  });
}
return out;
`.trim();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const scheduleTrigger = createNode(
  'Schedule Trigger',
  'n8n-nodes-base.scheduleTrigger',
  { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
  { position: [0, 300], typeVersion: 1.2 },
);

// Single obvious place to flip dry run off.
const config = createNode(
  'Config',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        { id: 'c1a0f0e2-1111-4a11-9111-aaaaaaaaaaaa', name: 'dryRun', value: true, type: 'boolean' },
      ],
    },
    options: {},
  },
  { position: [220, 300], typeVersion: 3.4 },
);

// --- Reference data, fetched once per run -----------------------------------
// These are chained (not parallel) so they are guaranteed to have run before
// the filter/Code node reference them. Each is followed by a Limit so the next
// node runs once rather than once per returned page.

function notionGetAll(name, dbId, position) {
  const n = createNode(
    name,
    'n8n-nodes-base.notion',
    {
      resource: 'databasePage',
      operation: 'getAll',
      databaseId: { __rl: true, mode: 'id', value: dbId },
      returnAll: true,
      filterType: 'none',
      options: {},
    },
    { position, typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
  );
  n.alwaysOutputData = true;   // an empty database must not stall the chain
  return n;
}
function keepOne(name, position) {
  return createNode(name, 'n8n-nodes-base.limit', { maxItems: 1 }, { position, typeVersion: 1 });
}

const getExistingNdas = notionGetAll('Get Existing NDAs', NDA_DB_ID, [440, 300]);
const oneNda = keepOne('Keep One (NDAs)', [660, 300]);
const getClients = notionGetAll('Get Clients', CLIENTS_DB_ID, [880, 300]);
const oneClient = keepOne('Keep One (Clients)', [1100, 300]);
const getPartners = notionGetAll('Get Partners', PARTNERS_DB_ID, [1320, 300]);
const onePartner = keepOne('Keep One (Partners)', [1540, 300]);

// --- Discover candidate files ----------------------------------------------

const listAccounts = createNode(
  'List Account Folders',
  'n8n-nodes-base.dropbox',
  { authentication: 'oAuth2', resource: 'folder', operation: 'list', path: ACCOUNTS_ROOT },
  { position: [1760, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);

const filterAccountFolders = createNode(
  'Filter: Account Folders',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'd1a0f0e2-2222-4a22-9222-bbbbbbbbbbbb',
          leftValue: '={{ $json.type }}',
          rightValue: 'folder',
          operator: { type: 'string', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1980, 300], typeVersion: 2.2 },
);

// Runs once per account. An account with no Contracts folder errors; that must
// not abort the whole run, so continue and let the PDF filter drop the item.
const listContracts = createNode(
  'List Contracts Folder',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'folder',
    operation: 'list',
    path: `={{ $json.pathLower }}/${CONTRACTS_SUBFOLDER.toLowerCase()}`,
  },
  { position: [2200, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
listContracts.onError = 'continueRegularOutput';

// type === 'file' keeps drafts out twice over: the listing is non-recursive, and
// this drops the draft SUBFOLDER entries themselves (and any error items).
const filterPdfs = createNode(
  'Filter: PDFs Only',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'e1a0f0e2-3333-4a33-9333-cccccccccccc',
          leftValue: '={{ $json.type }}',
          rightValue: 'file',
          operator: { type: 'string', operation: 'equals' },
        },
        {
          id: 'e1a0f0e2-4444-4a44-9444-dddddddddddd',
          leftValue: "={{ ($json.name || '').toLowerCase().endsWith('.pdf') }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2420, 300], typeVersion: 2.2 },
);

// accountName is derived from the path by locating the accounts-root segment,
// so it survives a change of root without re-indexing by hand.
const buildCandidate = createNode(
  'Build Candidate',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'f1a0f0e2-5555-4a55-9555-eeeeeeeeeeee',
          name: 'accountName',
          // Folders are named "acct <Company>" (e.g. "acct Twilio") but the
          // Clients/Partners databases hold the bare company ("Twilio"), so the
          // prefix is stripped here. Without this the title reads
          // "acct Twilio NDA" and relation matching relies on luck.
          value: `={{ $json.pathDisplay.split('/')[$json.pathDisplay.split('/').indexOf('${ACCOUNTS_ROOT.split('/').pop()}') + 1].replace(/^acct\\s+/i, '').trim() }}`,
          type: 'string',
        },
        { id: 'f1a0f0e2-6666-4a66-9666-ffffffffffff', name: 'filePath', value: '={{ $json.pathDisplay }}', type: 'string' },
        { id: 'f1a0f0e2-7777-4a77-9777-000000000001', name: 'fileName', value: '={{ $json.name }}', type: 'string' },
        {
          id: 'f1a0f0e2-8888-4a88-9888-000000000002',
          name: 'ndaUrl',
          // Deterministic from the path: computable without an extra Dropbox
          // call, clickable for Eve, and stable enough to be the dedup key.
          value: "={{ 'https://www.dropbox.com/home' + encodeURI($json.pathDisplay.substring(0, $json.pathDisplay.lastIndexOf('/'))) + '?preview=' + encodeURIComponent($json.name) }}",
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [2640, 300], typeVersion: 3.4 },
);

// Dedup against what is already in Notion. Referencing the fetched pages avoids
// a per-file lookup entirely.
const filterNew = createNode(
  'Filter: Not Already Recorded',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'a2a0f0e2-9999-4a99-9999-000000000003',
          // Two-part match. (1) exact ndaUrl — catches anything this workflow
          // created. (2) normalised FILENAME — catches the records Eve entered
          // by hand, whose NDA file holds a Dropbox *shared* link
          // (/scl/fi/<id>/<name>?rlkey=...), a format our computed /home/ link
          // can never equal. Without (2) the first live run would duplicate
          // every contract already recorded. Same filename in the same folder
          // is the same document, so a false positive here only ever skips a
          // true duplicate.
          leftValue: "={{ !$('Get Existing NDAs').all().some(p => (p.json.property_nda_file || '') === $json.ndaUrl || (String(p.json.property_nda_file || '').split('?')[0].split('/').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') === ($json.fileName || '').toLowerCase().replace(/[^a-z0-9]/g, '')) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2860, 300], typeVersion: 2.2 },
);

// --- Read and extract -------------------------------------------------------

const downloadContract = createNode(
  'Download Contract',
  'n8n-nodes-base.dropbox',
  { authentication: 'oAuth2', resource: 'file', operation: 'download', path: '={{ $json.filePath }}' },
  { position: [3080, 200], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
downloadContract.retryOnFail = true;
downloadContract.maxTries = 3;
downloadContract.waitBetweenTries = 2000;

const extractPdf = createNode(
  'Extract PDF Text',
  'n8n-nodes-base.extractFromFile',
  { operation: 'pdf', binaryPropertyName: 'data', options: {} },
  { position: [3300, 200], typeVersion: 1 },
);

const buildPrompt = createNode(
  'Build Prompt',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        { id: 'b2a0f0e2-1010-4a10-9010-000000000004', name: 'prompt', value: EXTRACTION_PROMPT, type: 'string' },
        // NDAs are short; the cap only guards against a pathological PDF.
        { id: 'b2a0f0e2-1111-4a11-9011-000000000005', name: 'contractText', value: "={{ ($json.text || '').slice(0, 60000) }}", type: 'string' },
        // The tool schema is carried as a LITERAL string (no leading '='), so
        // n8n never parses it as an expression. Inlining it into the request
        // expression broke the node: the schema contains '}}' sequences (e.g.
        // '"enum":["Yes","No"]}}'), and n8n's parser ends an expression at the
        // first '}}' it sees — producing "invalid syntax". Keep brace-heavy
        // JSON out of expressions and JSON.parse it back at point of use.
        { id: 'b2a0f0e2-1212-4a12-9012-000000000007', name: 'toolsJson', value: JSON.stringify([EXTRACTION_TOOL]), type: 'string' },
      ],
    },
    options: {},
  },
  { position: [3520, 200], typeVersion: 3.4 },
);

const extractFields = createNode(
  'Anthropic: Extract NDA Terms',
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
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    // Must stay a single-line, brace-light expression — see toolsJson above.
    jsonBody: '={{ JSON.stringify({ model: ' + JSON.stringify(EXTRACTION_MODEL)
      + ', max_tokens: 2000, tools: JSON.parse($json.toolsJson)'
      + ', tool_choice: { type: "tool", name: "record_nda" }'
      + ', messages: [{ role: "user", content: $json.prompt + "\\n\\n--- CONTRACT ---\\n\\n" + $json.contractText }] }) }}',
    options: {
      timeout: 120000,
      // Throttle to one contract at a time with a gap between calls, so a
      // folder-wide sweep can't burst into the Anthropic rate limit.
      batching: { batch: { batchSize: 1, batchInterval: 2500 } },
    },
  },
  { position: [3740, 200], typeVersion: 4.2, credentials: ANTHROPIC_HEADER_AUTH },
);
extractFields.retryOnFail = true;
extractFields.maxTries = 3;
extractFields.waitBetweenTries = 3000;

// Rejoin the model output with the file metadata by position. The forked
// passthrough is safer than a paired-item lookup: every node between the fork
// and here is 1:1 and fails the run on error, so positions cannot drift.
const mergeExtraction = createNode(
  'Merge Terms + File',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [3960, 300], typeVersion: 3 },
);

const buildRequest = createNode(
  'Build NDA Record',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_REQUEST_CODE },
  { position: [4180, 300], typeVersion: 2 },
);

// --- Write (or report) ------------------------------------------------------

const isDryRun = createNode(
  'Dry Run?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'c2a0f0e2-1212-4a12-9012-000000000006',
          leftValue: "={{ $('Config').first().json.dryRun }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4400, 300], typeVersion: 2.2 },
);

// Dry run terminates here: the item already carries the flat preview fields.
const dryRunReport = createNode(
  'Would Create (Dry Run)',
  'n8n-nodes-base.noOp',
  {},
  { position: [4620, 200], typeVersion: 1 },
);

const createRecord = createNode(
  'Create NDA Record',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [4620, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createRecord.retryOnFail = true;
createRecord.maxTries = 3;
createRecord.waitBetweenTries = 2000;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Ingest NDA Contracts', {
  nodes: [
    scheduleTrigger, config,
    getExistingNdas, oneNda, getClients, oneClient, getPartners, onePartner,
    listAccounts, filterAccountFolders, listContracts, filterPdfs,
    buildCandidate, filterNew,
    downloadContract, extractPdf, buildPrompt, extractFields,
    mergeExtraction, buildRequest, isDryRun, dryRunReport, createRecord,
  ],
  connections: [
    connect(scheduleTrigger, config),
    // Reference data first, each collapsed to one item so the next runs once.
    connect(config, getExistingNdas),
    connect(getExistingNdas, oneNda),
    connect(oneNda, getClients),
    connect(getClients, oneClient),
    connect(oneClient, getPartners),
    connect(getPartners, onePartner),
    // Discover candidate files
    connect(onePartner, listAccounts),
    connect(listAccounts, filterAccountFolders),
    connect(filterAccountFolders, listContracts),
    connect(listContracts, filterPdfs),
    connect(filterPdfs, buildCandidate),
    connect(buildCandidate, filterNew),
    // Extract, then rejoin with the file metadata by position
    connect(filterNew, downloadContract),
    connect(downloadContract, extractPdf),
    connect(extractPdf, buildPrompt),
    connect(buildPrompt, extractFields),
    connect(extractFields, mergeExtraction, 0, 0),
    connect(filterNew, mergeExtraction, 0, 1),
    connect(mergeExtraction, buildRequest),
    connect(buildRequest, isDryRun),
    connect(isDryRun, dryRunReport, 0),
    connect(isDryRun, createRecord, 1),
  ],
  settings: { executionOrder: 'v1' },
});
