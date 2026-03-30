/**
 * Contact Updates from Notion
 *
 * Sub-workflow called by the Contacts adapter when a contact record
 * changes in the Notion master contacts database. Filters out records
 * without an email, then calls the "Create or Update Mailchimp Record"
 * sub-workflow, passing all relevant fields including the Notion page ID
 * (required by the NOTIONID guard).
 *
 * Replaces: server/contact-updates-from-notion.json (ID: XfO5Zg1zn6A4vhD6)
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAILCHIMP_WORKFLOW_ID = 'qvhhwm0l47pZnP8c';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function schemaField(id, type = 'string', extra = {}) {
  return {
    id,
    displayName: id,
    required: false,
    defaultMatch: false,
    display: true,
    canBeUsedToMatch: true,
    type,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { position: [0, 0], typeVersion: 1.1 },
);

const mustHaveEmail = createNode(
  'Must Have Email Address',
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
  { position: [208, 0], typeVersion: 2.2 },
);

const updateMailchimp = createNode(
  'Update Mailchimp Record',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: MAILCHIMP_WORKFLOW_ID,
      mode: 'id',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        email_address: '={{ $json.Email }}',
        full_name: '={{ $json["First name"] }} {{ $json["Last name"] }}',
        status: "={{ $json['Email Marketing'] || 'subscribed' }}",
        FNAME: '={{ $json["First name"] }}',
        LNAME: '={{ $json["Last name"] }}',
        ADDRESS: '={{ { addr1: $json["Street address"] || "", addr2: $json["Address line 2"] || "", city: $json["City"] || "", state: $json["State"] || "", zip: $json["Postal code"] || "", country: $json["Country"] || "US" } }}',
        PHONE: '={{ $json.Phone }}',
        BIRTHDAY: '={{ $json.Birthday }}',
        COMPANY: '={{ $json["Company Name"] }}',
        Tags: '={{ $json.Tags }}',
        notion_page_id: '={{ $json.id }}',
      },
      matchingColumns: [],
      schema: [
        schemaField('email_address'),
        schemaField('full_name'),
        schemaField('status'),
        schemaField('FNAME'),
        schemaField('LNAME'),
        schemaField('ADDRESS', 'object'),
        schemaField('PHONE'),
        schemaField('BIRTHDAY'),
        schemaField('COMPANY'),
        schemaField('Tags', 'array'),
        schemaField('notion_page_id'),
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {
      waitForSubWorkflow: true,
    },
  },
  { position: [432, 0], typeVersion: 1.2 },
);

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Contact Updates from Notion', {
  nodes: [trigger, mustHaveEmail, updateMailchimp],
  connections: [
    connect(trigger, mustHaveEmail),
    connect(mustHaveEmail, updateMailchimp),
  ],
  settings: {
    executionOrder: 'v1',
  },
});
