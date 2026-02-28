/**
 * Ingest Substack Subscribers
 *
 * Scheduled workflow that picks up Substack subscriber CSV exports from
 * Dropbox, parses them, and upserts each subscriber into the Notion
 * master contacts database via the Notion Master Contact Upsert
 * sub-workflow.
 *
 * Flow:
 *   1. Schedule Trigger fires daily
 *   2. List Dropbox folder for subscriber CSV files
 *   3. Filter to files only, sort by date, take the most recent
 *   4. Download and parse the CSV (columns: Email, Name)
 *   5. Filter records with valid email
 *   6. Map each record to the contact upsert shape (split Name → first/last)
 *   7. Call Notion Master Contact Upsert sub-workflow
 *   8. Move the processed CSV to a /Processed/ subfolder
 *
 * If no valid email records exist, the file is still moved to /Processed/.
 *
 * Substack CSV format:
 *   Email,Name
 *   user@example.com,Jane Doe
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const UPSERT_WORKFLOW_ID = 'EnwxsZaLNrYqKBDa';
const DROPBOX_FOLDER = '/Filing Cabinet/*Venn Factory/ops/Substack/Subscribers';
const DROPBOX_CREDENTIAL = {
  dropboxOAuth2Api: { id: '5p74zyJBc4pRsoO4', name: 'Dropbox account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const scheduleTrigger = createNode(
  'Schedule Trigger',
  'n8n-nodes-base.scheduleTrigger',
  {
    rule: {
      interval: [{ field: 'days', triggerAtHour: 6 }],
    },
  },
  { position: [0, 0], typeVersion: 1.2 },
);

const listFolder = createNode(
  'List Dropbox Folder',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'folder',
    operation: 'list',
    path: DROPBOX_FOLDER,
    filters: {},
  },
  { position: [200, 0], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
listFolder.retryOnFail = true;

const filterFiles = createNode(
  'Filter Files Only',
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
          leftValue: '={{ $json[".tag"] }}',
          rightValue: 'file',
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
  { position: [400, 0], typeVersion: 2.2 },
);

const sortByDate = createNode(
  'Sort by Date',
  'n8n-nodes-base.sort',
  {
    sortField: [
      {
        fieldName: 'lastModifiedServer',
        order: 'descending',
      },
    ],
  },
  { position: [600, 0], typeVersion: 1 },
);

const takeMostRecent = createNode(
  'Take Most Recent',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: 'return [$input.first()];',
  },
  { position: [800, 0], typeVersion: 2 },
);

const downloadCsv = createNode(
  'Download CSV',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'download',
    path: '={{ $json.pathLower }}',
  },
  { position: [1000, 0], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
downloadCsv.retryOnFail = true;

const parseCsv = createNode(
  'Parse CSV',
  'n8n-nodes-base.extractFromFile',
  {
    options: {
      delimiter: ',',
      headerRow: true,
    },
  },
  { position: [1200, 0], typeVersion: 1 },
);

const hasEmail = createNode(
  'Has Email?',
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
          leftValue: '={{ $json.Email }}',
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
  { position: [1400, 0], typeVersion: 2.2 },
);
hasEmail.alwaysOutputData = true;

// Branch: did any valid records pass the filter?
const ifNoValidRecords = createNode(
  'If No Valid Records',
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
          leftValue: '={{ $json.Email }}',
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
  { position: [1600, 0], typeVersion: 2.2 },
);

// Map the CSV row into the contact shape expected by the upsert sub-workflow.
// Splits Name into first_name / last_name.
const mapToContact = createNode(
  'Map to Contact',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const name = ($json.Name || "").trim();
const parts = name.split(/\\s+/);
const first_name = parts[0] || null;
const last_name = parts.length > 1 ? parts.slice(1).join(" ") : null;

return {
  json: {
    email: $json.Email,
    first_name,
    last_name,
    tags: ["Substack"],
    email_marketing: "Subscribed",
  },
};`,
  },
  { position: [1800, -100], typeVersion: 2 },
);

const upsertContact = createNode(
  'Upsert Contact',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: UPSERT_WORKFLOW_ID,
      mode: 'id',
    },
    options: {},
  },
  { position: [2000, -100], typeVersion: 1.2 },
);
upsertContact.alwaysOutputData = true;

// Merge ensures the file-move step runs regardless of whether there were
// valid records. Input 0 = records processed, Input 1 = no valid records.
const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'chooseBranch',
    output: 'input2',
  },
  { position: [2200, 0], typeVersion: 3 },
);

// Build the destination path: move the file into a /Processed/ subfolder.
const buildProcessedPath = createNode(
  'Build Processed Path',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const item = $('Take Most Recent').first();
const sourcePath = item.json.pathLower;
const parts = sourcePath.split("/");
const fileName = parts.pop();
const folder = parts.join("/");
const destinationPath = folder + "/Processed/" + fileName;

return [{ json: { sourcePath, destinationPath } }];`,
  },
  { position: [2400, 0], typeVersion: 2 },
);

const moveToProcessed = createNode(
  'Move to Processed',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'move',
    path: '={{ $json.sourcePath }}',
    toPath: '={{ $json.destinationPath }}',
  },
  { position: [2600, 0], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
moveToProcessed.retryOnFail = true;

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Ingest Substack Subscribers', {
  nodes: [
    scheduleTrigger, listFolder, filterFiles, sortByDate, takeMostRecent,
    downloadCsv, parseCsv, hasEmail, ifNoValidRecords,
    mapToContact, upsertContact,
    merge, buildProcessedPath, moveToProcessed,
  ],
  connections: [
    connect(scheduleTrigger, listFolder),
    connect(listFolder, filterFiles),
    connect(filterFiles, sortByDate),
    connect(sortByDate, takeMostRecent),
    connect(takeMostRecent, downloadCsv),
    connect(downloadCsv, parseCsv),
    connect(parseCsv, hasEmail),
    connect(hasEmail, ifNoValidRecords),
    // True branch (has valid records) → map and upsert, then merge input 0
    connect(ifNoValidRecords, mapToContact, 0, 0),
    connect(mapToContact, upsertContact),
    connect(upsertContact, merge, 0, 0),
    // False branch (no valid records) → merge input 1
    connect(ifNoValidRecords, merge, 1, 1),
    // After merge, build path and move file
    connect(merge, buildProcessedPath),
    connect(buildProcessedPath, moveToProcessed),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});
