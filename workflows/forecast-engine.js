import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Trigger ---
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  {
    typeVersion: 1.1,
    position: [-384, -256],
    id: 'c4dcd732-484c-41ca-b344-a0c84e903bff',
  }
);

// --- If (validate engagement data) ---
const ifNode = createNode(
  'If',
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
          id: '2b9ceb97-368b-40a1-8c4b-9dcad4b93e68',
          leftValue: '={{ $json["Engagement start&end"].start }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '9d12ac77-d85f-41c7-90f7-28cd6be6911a',
          leftValue: '={{ $json["Engagement start&end"].end }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'dbfd21d1-a064-48a6-a9aa-6f35d7b9cb79',
          leftValue: '={{ $json["Payment terms"] }}',
          rightValue: '/(due on receipt)|(net +\\d+)/i',
          operator: { type: 'string', operation: 'regex' },
        },
        {
          id: '5eaed077-021c-4a29-968e-6e49de09ccfa',
          leftValue: '={{ $json["Cycle length"] }}',
          rightValue: '/month|quarter|year/i',
          operator: { type: 'string', operation: 'regex' },
        },
        {
          id: 'be061079-c81a-4c41-8ab6-72de23123821',
          leftValue: '={{ $json.Currency }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: 'f6642fb6-671f-4a14-b378-c28fd6b4793d',
          leftValue: '={{ $json["Client db"] }}',
          rightValue: 1,
          operator: { type: 'array', operation: 'lengthEquals', rightType: 'number' },
        },
        {
          id: '5bea787d-8d02-4d9f-8075-e3c60bbf1ee6',
          leftValue: '={{ $json["Sales pipeline"] }}',
          rightValue: 1,
          operator: { type: 'array', operation: 'lengthEquals', rightType: 'number' },
        },
        {
          id: '63c1ae23-fb77-4770-b585-b0f7ef355a54',
          leftValue: '={{ $json["Client db"][0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
        {
          id: '6fbfe47b-0981-4958-9035-82f2f34bcf3b',
          leftValue: '={{ $json["Sales pipeline"][0] }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-160, -256],
    id: '16a1d8cc-3bde-46b2-be83-a97f1621e7c9',
  }
);

// --- Notion1 (lookup existing forecast entries) ---
const notion1 = createNode(
  'Notion1',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: {
      __rl: true,
      value: '1c98ebaf-15ee-809f-8a5f-ced93c82e98b',
      mode: 'list',
      cachedResultName: 'Forecast',
      cachedResultUrl: 'https://www.notion.so/1c98ebaf15ee809f8a5fced93c82e98b',
    },
    returnAll: true,
    filterType: 'manual',
    filters: {
      conditions: [
        {
          key: 'Title|title',
          condition: 'starts_with',
          titleValue: '={{ $json.id }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [64, -544],
    id: '5e5a0c7e-e22c-43c6-bed7-3dd5878986a2',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
notion1.alwaysOutputData = true;
notion1.retryOnFail = true;
notion1.onError = 'continueRegularOutput';

// --- Notion2 (archive existing forecast entries) ---
const notion2 = createNode(
  'Notion2',
  'n8n-nodes-base.notion',
  {
    operation: 'archive',
    pageId: {
      __rl: true,
      value: '={{ $json.id }}',
      mode: 'id',
    },
  },
  {
    typeVersion: 2.2,
    position: [288, -544],
    id: 'c4fa4e96-89f5-487a-a0f6-2b785c081aa2',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
notion2.alwaysOutputData = true;
notion2.retryOnFail = true;
notion2.onError = 'continueRegularOutput';

// --- Code (calculate payment periods) ---
const code = createNode(
  'Code',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: "// output a list of amounts by month from the start of the engagement to the\n// end\n// keep in mind the payment terms, cycle length, start and ending payments too\n\nlet startDate = new Date($input.item.json[\"Engagement start&end\"].start);\nlet endDate = new Date($input.item.json[\"Engagement start&end\"].end);\nlet cycleCount = $input.item.json[\"Cycle count\"];\n\nlet cyclesProcessed = 0;\n\n\nlet result = {\n  json:{}\n};\n\nlet cycleLength = 1;\nlet terms=0;\n\nswitch ($input.item.json[\"Cycle length\"]) {\n  case \"Month\":\n    cycleLength = 1;\n    break;\n  case \"Quarter\":\n    cycleLength = 3;\n    break;\n  case \"Year\":\n    cycleLength = 12;\n    break;\n}\nif ($input.item.json[\"Payment terms\"] == \"Due on receipt\") {\n  terms=0;\n}\nelse {\n  let vals = $input.item.json[\"Payment terms\"].match(/net +(\\d+)/i);\n\n  if (vals && vals.length == 2) {\n    terms=Number.parseInt(vals[1], 10);\n  }\n  else throw new Error(\"could not parse terms: \" + $input.item.json[\"Payment terms\"]);\n}\n\n// make sure the start is on a business day\nif (startDate.getDay() === 0) { // Sunday\n  startDate.setDate(startDate.getDate() + 1);\n}\nelse if (startDate.getDay() === 6) { // Saturday\n  startDate.setDate(startDate.getDate() + 2);\n}\n\nconst engagementTypes = $input.item.json[\"Engagement type\"] || [\"Internal\"];\nconst engagementType = engagementTypes[0];\n\n\nlet template = {\n  \"engagementId\": $input.item.json.id,\n  \"engagementType\": engagementType,\n    \"currency\": $input.item.json[\"Currency\"],\n    \"clientId\": $input.item.json[\"Client db\"][0],\n    \"pipelineId\": $input.item.json[\"Sales pipeline\"][0]\n};\n\nresult.json.periods = [];\n\n//result.json.startDate = startDate;\n//result.json.endDate = endDate;\n\n\nlet d = new Date(startDate.toISOString());\nlet pmtDate = new Date(d.toISOString());\n\npmtDate.setDate(pmtDate.getDate()+terms);\n\n// initial payment\nif ($input.item.json[\"Due at start\"] > 0) {\n  result.json.periods.push(Object.assign({\n    date: pmtDate.toISOString(),\n    amount: $input.item.json[\"Due at start\"]\n  }, template));\n}\n\n// find all the dates that mark cycle ends\n\nfor (d.setMonth(startDate.getMonth()+cycleLength); d <= endDate || cyclesProcessed < cycleCount; d.setMonth(d.getMonth()+cycleLength)) {\n  pmtDate.setTime(d.getTime());\n  pmtDate.setDate(pmtDate.getDate()+terms);\n    \n  result.json.periods.push(Object.assign({\n    date: pmtDate.toISOString(),\n    amount: $input.item.json[\"Cycle payment\"],\n  }, template)); \n  cyclesProcessed++;\n}\n\nif ($input.item.json[\"Due at end\"] > 0) {\n  d.setTime(endDate.getTime());\n  pmtDate.setTime(d.getTime());\n  pmtDate.setDate(pmtDate.getDate()+terms);\n\n  result.json.periods.push(Object.assign({\n    date: pmtDate.toISOString(),\n    amount: $input.item.json[\"Due at end\"],\n    currency: $input.item.json[\"Currency\"]\n  }, template)); \n}\n\nreturn result;",
  },
  {
    typeVersion: 2,
    position: [64, -352],
    id: '1d154bab-25ca-414b-b195-51468da914cf',
  }
);

// --- Split Out ---
const splitOut = createNode(
  'Split Out',
  'n8n-nodes-base.splitOut',
  { fieldToSplitOut: 'periods', options: {} },
  {
    typeVersion: 1,
    position: [288, -352],
    id: '5424c356-f07a-45d9-995e-dbb8a620cc5e',
  }
);

// --- Wait for Delete (Merge) ---
const waitForDelete = createNode(
  'Wait for Delete',
  'n8n-nodes-base.merge',
  { mode: 'chooseBranch', useDataOfInput: 2 },
  {
    typeVersion: 3,
    position: [512, -352],
    id: '5b643d4f-5563-47b0-a878-9827f3659d4e',
  }
);

// --- If USD ---
const ifUSD = createNode(
  'If USD',
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
          id: '72615335-1f6e-4c7c-80f3-eed408c59bee',
          leftValue: '={{ $json.currency }}',
          rightValue: 'USD',
          operator: { type: 'string', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [736, -352],
    id: '02c742c2-01b4-4f1c-a2fc-fbd728ec5aae',
  }
);

// --- Copy USD Amount ---
const copyUSD = createNode(
  'Copy USD Amount',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '6fa6b155-840b-49ef-9bbd-4142bf8ffe9a',
          name: 'amountUSD',
          value: '={{ $json.amount }}',
          type: 'number',
        },
      ],
    },
    includeOtherFields: true,
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [1408, -544],
    id: '6f35f479-9b0f-4fae-962d-89c0773dcc2a',
  }
);
copyUSD.alwaysOutputData = true;

// --- Convert Currency ---
const convertCurrency = createNode(
  'Convert Currency',
  'n8n-nodes-base.httpRequest',
  {
    url: 'https://api.frankfurter.app/latest',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'from', value: '={{ $json.currency }}' },
        { name: 'to', value: 'USD' },
        { name: 'amount', value: '={{ $json.amount }}' },
      ],
    },
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [960, -208],
    id: '154bd909-b60c-48f5-83fb-8942142ebdc8',
  }
);
convertCurrency.executeOnce = false;
convertCurrency.alwaysOutputData = true;
convertCurrency.retryOnFail = true;

// --- Inject USD Amount ---
const injectUSD = createNode(
  'Inject USD Amount',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: '8a9a5c3c-8ada-4c67-87a9-7a330be7b757',
          name: 'amountUSD',
          value: '={{ $json.rates.USD }}',
          type: 'string',
        },
        {
          id: '1431398a-5d0f-4674-9a28-2d372df98db0',
          name: 'date',
          value: "={{ $('If USD').item.json.date }}",
          type: 'string',
        },
        {
          id: '124d9659-5bf1-46c2-be6e-954214e59daa',
          name: 'amount',
          value: "={{ $('If USD').item.json.amount }}",
          type: 'number',
        },
        {
          id: 'fa794c0c-725a-4535-9e3b-2cd28e4839f6',
          name: 'engagementId',
          value: "={{ $('If USD').item.json.engagementId }}",
          type: 'string',
        },
        {
          id: 'f12c6eff-558f-456b-8745-370fb23a1272',
          name: 'engagementType',
          value: "={{ $('If USD').item.json.engagementType }}",
          type: 'string',
        },
        {
          id: '2e31de5b-31ca-4929-b2f8-bb59bb83d7fb',
          name: 'currency',
          value: "={{ $('If USD').item.json.currency }}",
          type: 'string',
        },
        {
          id: 'c2065b03-ddc4-44c0-aeca-fe347d89bd90',
          name: 'clientId',
          value: "={{ $('If USD').item.json.clientId }}",
          type: 'string',
        },
        {
          id: '9c4a17c1-ade4-4bf3-9611-0d092d306910',
          name: 'pipelineId',
          value: "={{ $('If USD').item.json.pipelineId }}",
          type: 'string',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 3.4,
    position: [1184, -208],
    id: 'edd85e1c-67a7-4d4a-9909-b878a89894cc',
  }
);
injectUSD.alwaysOutputData = true;

// --- Eliminate Empty Records (Filter) ---
const eliminateEmpty = createNode(
  'Eliminate Empty Records',
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
          id: '3475998a-e419-4b2a-9f14-7101c2cc7e78',
          leftValue: '={{ $json.date }}',
          rightValue: '',
          operator: { type: 'string', operation: 'exists', singleValue: true },
        },
        {
          id: '873bc454-b645-47bc-ae67-05efca1a44c3',
          leftValue: '={{ $json.amount }}',
          rightValue: '',
          operator: { type: 'number', operation: 'exists', singleValue: true },
        },
        {
          id: '6f290335-c428-4d49-813c-ffac690bb39a',
          leftValue: '={{ $json.amount }}',
          rightValue: 0,
          operator: { type: 'number', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1632, -448],
    id: '3d67121e-922f-47d7-b640-8e83d04e37a6',
  }
);

// --- Notion (create forecast entry) ---
const notion = createNode(
  'Notion',
  'n8n-nodes-base.notion',
  {
    resource: 'databasePage',
    databaseId: {
      __rl: true,
      value: '1c98ebaf-15ee-809f-8a5f-ced93c82e98b',
      mode: 'list',
      cachedResultName: 'Forecast',
      cachedResultUrl: 'https://www.notion.so/1c98ebaf15ee809f8a5fced93c82e98b',
    },
    propertiesUi: {
      propertyValues: [
        { key: 'Forecast Date|date', date: '={{ $json.date }}' },
        { key: 'currency|select', selectValue: '={{ $json.currency }}' },
        { key: 'amount|number', numberValue: '={{ +$json.amount }}' },
        { key: 'amountUSD|number', numberValue: '={{ +$json.amountUSD }}' },
        {
          key: 'engagment type|select',
          selectValue: '={{ $json.engagementType }}',
        },
        {
          key: 'Title|title',
          title: '={{ $json.engagementId }}-{{ $json.date.substring(0,7) }}',
        },
      ],
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [1856, -448],
    id: '2c62eec3-dd26-4b54-a1d4-e54b87f45751',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
notion.executeOnce = false;
notion.retryOnFail = true;

// --- Link Engagement Reference (HTTP PATCH) ---
const linkRef = createNode(
  'Link Engagement Reference',
  'n8n-nodes-base.httpRequest',
  {
    method: 'PATCH',
    url: '=https://api.notion.com/v1/pages/{{ $json.id }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={\n  "properties": {\n    "engagement": {\n      "relation": [\n        {"id": "{{ $(\'Eliminate Empty Records\').item.json.engagementId }}" }\n      ]\n    },\n    "client": {\n      "relation": [\n        {"id": "{{ $(\'Eliminate Empty Records\').item.json.clientId }}" }\n      ]\n    },\n    "pipeline": {\n      "relation": [\n        {"id": "{{ $(\'Eliminate Empty Records\').item.json.pipelineId }}" }\n      ]\n    }\n  }\n} ',
    options: {},
  },
  {
    typeVersion: 4.2,
    position: [2080, -448],
    id: '51b1795e-2a71-4382-aa06-7eb08b6da7ce',
    credentials: {
      notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
    },
  }
);
linkRef.retryOnFail = true;

// --- Send Email (missing data notification) ---
const sendEmail = createNode(
  'Send Email',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: 'eli@heavylift.tech',
    toEmail: 'eve@xmlgrrl.com, eli@eliasisrael.com',
    subject: 'Forecast Entry Missing Data',
    html: '=<html>\n<body>\n<p>The engagement for {{ $json["-"] }} is missing data and cannot be added to forecast.\n<p>\n<p>Each engagement needs:\n<ul>\n<li>Start and end dates</li>\n<li>A currency</li>\n<li>Payment terms</li>\n<li>A cycle length</li>\n<li>Client</li>\n<li>Sales pipeline item</li>\n</ul>\n</p>\n</body>\n</html>',
    options: {
      appendAttribution: false,
    },
  },
  {
    typeVersion: 2.1,
    position: [64, -160],
    id: 'f8397870-c0b2-4c74-ac2d-fc1ba3101c9b',
    credentials: {
      smtp: { id: 'oztI4hqIZ7r3dUx7', name: 'AWS SES SMTP' },
    },
  }
);
sendEmail.webhookId = '87339776-3692-4bf6-b42a-36623442b149';

// --- Done (NoOp) ---
const done = createNode(
  'Done',
  'n8n-nodes-base.noOp',
  {},
  {
    typeVersion: 1,
    position: [288, -160],
    id: '46664612-b62c-4d3d-a6df-2e771cb0e041',
  }
);

// --- Connections ---
const connections = [
  connect(trigger, ifNode),
  // If true → Notion1 + Code
  connect(ifNode, notion1, 0),
  connect(ifNode, code, 0),
  // If false → Send Email
  connect(ifNode, sendEmail, 1),
  // Delete path
  connect(notion1, notion2),
  connect(notion2, waitForDelete, 0, 0),
  // Code path
  connect(code, splitOut),
  connect(splitOut, waitForDelete, 0, 1),
  // After merge
  connect(waitForDelete, ifUSD),
  // USD path
  connect(ifUSD, copyUSD, 0),
  // Non-USD path
  connect(ifUSD, convertCurrency, 1),
  connect(convertCurrency, injectUSD),
  // Both paths converge
  connect(copyUSD, eliminateEmpty),
  connect(injectUSD, eliminateEmpty),
  // Create forecast
  connect(eliminateEmpty, notion),
  connect(notion, linkRef),
  // Error email path
  connect(sendEmail, done),
];

export default createWorkflow('Forecast Engine', {
  nodes: [
    code,
    splitOut,
    notion,
    linkRef,
    ifUSD,
    notion1,
    notion2,
    convertCurrency,
    copyUSD,
    injectUSD,
    eliminateEmpty,
    waitForDelete,
    ifNode,
    sendEmail,
    done,
    trigger,
  ],
  connections,
  settings: {
    executionOrder: 'v1',
    timezone: 'America/Denver',
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: [
    {
      updatedAt: '2025-02-16T13:01:39.065Z',
      createdAt: '2025-02-16T13:01:39.065Z',
      id: 'IzLCnCZq9323eiAZ',
      name: 'Production',
    },
  ],
});
