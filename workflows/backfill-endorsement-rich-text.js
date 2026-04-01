/**
 * Backfill Endorsement Rich Text
 *
 * One-off utility: reads every endorsement from the Notion database and
 * calls Book Endorsements Management for each one, which will fetch the
 * full rich_text and write HTML to the new endorsement-body-2 Webflow field.
 *
 * Run once after deploying the rich text changes. Records without a
 * WebflowId will go through the create path in the sub-workflow; records
 * with a WebflowId will be updated.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const MANAGEMENT_WORKFLOW_ID = 'gmtPuFBhZ56ImCcX';
const ENDORSEMENTS_DATABASE_ID = '3028ebaf-15ee-8023-82ae-c94c75e1aa4d';

const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When clicking "Test workflow"',
  'n8n-nodes-base.manualTrigger',
  {},
  { position: [0, 0], typeVersion: 1 },
);

// Fetch all endorsement pages from Notion with simplified output so property
// names match what the adapter normally passes to the management workflow.
const getAllEndorsements = createNode(
  'Get All Endorsements',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: ENDORSEMENTS_DATABASE_ID,
      mode: 'id',
    },
    returnAll: true,
    simple: true,
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [224, 0],
    credentials: NOTION_CREDENTIAL,
  },
);

// Call Book Endorsements Management for each record with the same field
// shape the adapter normally sends it.
const syncEndorsement = createNode(
  'Sync Endorsement',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: MANAGEMENT_WORKFLOW_ID,
      mode: 'id',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        'NotionId':          '={{ $json.id }}',
        'Name':              '={{ $json.name }}',
        'Endorser Name':     '={{ $json.property_name }}',
        'Ensorser Title':    '={{ $json.property_title }}',
        'Organization':      '={{ $json.property_affiliation }}',
        'Endorser Title 2':  '={{ $json.property_title_2 }}',
        'Organization 2':    '={{ $json.property_affiliation_2 }}',
        'Endorsement Body':  '={{ $json.property_endorsement }}',
        'WebflowId':         '={{ $json.property_webflow_id }}',
        'Enabled':           '={{ $json.property_final }}',
        'Spotlight':         '={{ $json.property_spotlight }}',
      },
      matchingColumns: [],
      schema: [
        { id: 'NotionId',         displayName: 'NotionId',         required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Name',             displayName: 'Name',             required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Endorser Name',    displayName: 'Endorser Name',    required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Ensorser Title',   displayName: 'Ensorser Title',   required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Organization',     displayName: 'Organization',     required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Endorser Title 2', displayName: 'Endorser Title 2', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Organization 2',   displayName: 'Organization 2',   required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Endorsement Body', displayName: 'Endorsement Body', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'WebflowId',        displayName: 'WebflowId',        required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'Enabled',          displayName: 'Enabled',          required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'boolean' },
        { id: 'Spotlight',        displayName: 'Spotlight',        required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'boolean' },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {
      waitForSubWorkflow: true,
    },
  },
  { position: [448, 0], typeVersion: 1.2 },
);

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export default createWorkflow('Backfill Endorsement Rich Text', {
  nodes: [trigger, getAllEndorsements, syncEndorsement],
  connections: [
    connect(trigger, getAllEndorsements),
    connect(getAllEndorsements, syncEndorsement),
  ],
  tags: ['Dev'],
});
