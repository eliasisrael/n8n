import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Error Trigger ---
const errorTrigger = createNode(
  'Error Trigger',
  'n8n-nodes-base.errorTrigger',
  {},
  {
    typeVersion: 1,
    position: [-320, 100],
    id: 'b68184ca-49fd-41d6-a767-e0c82b44a83c',
  }
);

// --- If Trigger Error ---
const ifTriggerError = createNode(
  'If Trigger Error',
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
          id: 'c6b5cae7-8765-4341-968e-ca128b866e87',
          leftValue: '={{ $json.trigger }}',
          rightValue: '',
          operator: {
            type: 'object',
            operation: 'exists',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  {
    typeVersion: 2.2,
    position: [-120, 100],
    id: '9dc193cd-1fc2-450b-a09c-4bd59864da84',
  }
);

// --- HTML (regular error) ---
const html = createNode(
  'HTML',
  'n8n-nodes-base.html',
  {
    html: '<html>\n<head>\n  <title>Error in {{ $json.workflow.name }} </title>\n</head>\n<body>\n  <div class="container">\n    <h1>Workflow Error: {{ $json.workflow.name || \'\'}}</h1>\n    <p>{{ $json.execution.error.message }}</p>\n    <p>{{ $json.execution.error.description || \'\' }}</p>\n  </div>\n  <div>\n    <h1>Stack</h1>\n    <code>\n      {{ ($json.execution.error.stack || \'\').replaceAll("\\n", "<br/>") }}\n    </code>\n  </div>\n</body>\n</html>',
  },
  {
    typeVersion: 1.2,
    position: [120, 180],
    id: 'a4c569b9-111e-43e3-b505-6a715d3bf016',
  }
);

// --- HTML1 (trigger error) ---
const html1 = createNode(
  'HTML1',
  'n8n-nodes-base.html',
  {
    html: '<html>\n<head>\n  <title>Error in {{ $json.workflow.name }} </title>\n</head>\n<body>\n  <div class="container">\n    <h1>Trigger Error: {{ $json.workkflow.name }}</h1>\n    <p></p>A trigger error occurred on {{ $json.workflow.name }}.</p>\n    <p>You may need to deactivate, test, and reactivate the workflow.</p>\n  </div>\n</body>\n</html>',
  },
  {
    typeVersion: 1.2,
    position: [120, -180],
    id: 'd6aa0770-9b81-47ac-9764-7bebf2f94966',
  }
);

// --- Merge (regular error) ---
const merge = createNode(
  'Merge',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [340, 300],
    id: 'fbd86040-a08a-4418-8e31-4b13c3a5b136',
  }
);

// --- Merge1 (trigger error) ---
const merge1 = createNode(
  'Merge1',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  {
    typeVersion: 3.1,
    position: [340, -100],
    id: '9d749a74-eb0f-4aaf-a900-4375618eccd8',
  }
);

// --- Send Email (regular error) ---
const sendEmail = createNode(
  'Send Email',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: 'eli@heavylift.tech',
    toEmail: 'eli@eliasisrael.com, eve@vennfactory.com',
    subject: '=Workflow Error: {{ $json.workflow.name }}',
    emailFormat: 'both',
    text: '=Error in {{ $json.workflow.name }}: {{ $json.execution.error.message }}\n\nStack:\n{{ $json.execution.error.stack }}',
    html: '={{ $json.html }}',
    options: {
      appendAttribution: false,
    },
  },
  {
    typeVersion: 2.1,
    position: [560, 200],
    id: '48d57a41-b205-462a-8e01-e69ae6f81d27',
    credentials: {
      smtp: {
        id: 'oztI4hqIZ7r3dUx7',
        name: 'AWS SES SMTP',
      },
    },
  }
);
sendEmail.webhookId = '7fdc0f14-79df-4881-b76d-d8be25bcbf9b';

// --- Send Email1 (trigger error) ---
const sendEmail1 = createNode(
  'Send Email1',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: 'eli@heavylift.tech',
    toEmail: 'eli@eliasisrael.com',
    subject: '=Trigger Error: {{ $json.workflow.name }}',
    html: '={{ $json.html }}',
    options: {},
  },
  {
    typeVersion: 2.1,
    position: [560, -200],
    id: 'f11f3938-7deb-4eb5-b561-f835a268f95f',
    credentials: {
      smtp: {
        id: 'oztI4hqIZ7r3dUx7',
        name: 'AWS SES SMTP',
      },
    },
  }
);
sendEmail1.webhookId = '4784b621-4bcf-4463-9144-01016cbc9226';

// --- Pushover (regular error) ---
const pushover = createNode(
  'Pushover',
  'n8n-nodes-base.pushover',
  {
    userKey: 'u8cx9933n6kq69g1uotjavhxcwri7n',
    message:
      '=Error In Workflow "{{ $json.workflow.name }}" while proccesing "{{ $json.execution.lastNodeExecuted }}"',
    priority: 2,
    additionalFields: {
      url: '={{ $json.execution.url }}',
    },
  },
  {
    typeVersion: 1,
    position: [560, 400],
    id: 'c0329fd7-9cba-4d8c-beb9-496786d217d5',
    credentials: {
      pushoverApi: {
        id: '8yRL2WE5w6WO2crY',
        name: 'Pushover account',
      },
    },
  }
);

// --- Pushover1 (trigger error) ---
const pushover1 = createNode(
  'Pushover1',
  'n8n-nodes-base.pushover',
  {
    userKey: 'u8cx9933n6kq69g1uotjavhxcwri7n',
    message: '=Trigger Error: {{ $json.workflow.name }}',
    priority: 2,
    additionalFields: {},
  },
  {
    typeVersion: 1,
    position: [560, 0],
    id: '4b19a951-baa4-47e9-913a-9fbdd37c1515',
    credentials: {
      pushoverApi: {
        id: '8yRL2WE5w6WO2crY',
        name: 'Pushover account',
      },
    },
  }
);

// --- Connections ---
const connections = [
  connect(errorTrigger, ifTriggerError),
  // True branch (trigger error): output 0 → HTML1 + Merge1 input 1
  connect(ifTriggerError, html1, 0),
  connect(ifTriggerError, merge1, 0, 1),
  // False branch (regular error): output 1 → HTML + Merge input 1
  connect(ifTriggerError, html, 1),
  connect(ifTriggerError, merge, 1, 1),
  // HTML paths feed merge input 0
  connect(html, merge, 0, 0),
  connect(html1, merge1, 0, 0),
  // Merge outputs to email + pushover
  connect(merge, sendEmail),
  connect(merge, pushover),
  connect(merge1, sendEmail1),
  connect(merge1, pushover1),
];

export default createWorkflow('Error Handler', {
  nodes: [
    errorTrigger,
    pushover,
    sendEmail,
    html,
    merge,
    ifTriggerError,
    html1,
    merge1,
    sendEmail1,
    pushover1,
  ],
  connections,
  settings: {
    executionOrder: 'v1',
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
