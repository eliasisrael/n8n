import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// =============================================================================
// Error Handler — production error workflow for all n8n workflows
//
// Flow:
//   Error Trigger → Normalize (Code) → Self-Loop Check (IF)
//     → Self-loop: Fallback Pushover only (avoid cascading failures)
//     → Normal: Classify Severity (Switch)
//       → Critical: HTML Email (eli + eve) + Pushover (emergency, priority 2)
//       → Warning:  HTML Email (eli + eve) + Pushover (high, priority 1)
//       → Info:     HTML Email (eli only)
//
// Should be activated on the server and assigned as the error workflow for
// all production workflows.
// =============================================================================

// Credentials
const SMTP_CREDENTIAL = {
  smtp: { id: 'oztI4hqIZ7r3dUx7', name: 'AWS SES SMTP' },
};
const PUSHOVER_CREDENTIAL = {
  pushoverApi: { id: '8yRL2WE5w6WO2crY', name: 'Pushover account' },
};
const PUSHOVER_USER_KEY = 'u8cx9933n6kq69g1uotjavhxcwri7n';
const FROM_EMAIL = 'eli@heavylift.tech';
const TO_ALL = 'eli@eliasisrael.com, eve@vennfactory.com';
const TO_ELI = 'eli@eliasisrael.com';

// --- Error Trigger ---
const errorTrigger = createNode(
  'Error Trigger',
  'n8n-nodes-base.errorTrigger',
  {},
  {
    typeVersion: 1,
    position: [-400, 300],
    id: 'b68184ca-49fd-41d6-a767-e0c82b44a83c',
  }
);

// --- Normalize Error (Code) ---
// Produces a unified shape from both execution errors and trigger errors.
const normalize = createNode(
  'Normalize Error',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: `\
const exec = $json.execution || null;
const trig = $json.trigger || null;
const wf = $json.workflow || {};

const isExecution = Boolean(exec);
const workflowUrl = 'https://n8n.vennfactory.com/workflow/' + wf.id;

// Classify severity based on workflow name
const name = (wf.name || '').toLowerCase();
let severity = 'info';
if (
  name.includes('adapter-') ||
  name.includes('webhook-router') ||
  name.includes('notion webhook router') ||
  name === 'upsert-contact' ||
  name === 'mailchimp-audience-hook' ||
  name === 'mailchimp-audience-processor' ||
  name.includes('qstash')
) {
  severity = 'critical';
} else if (
  name.includes('-management') ||
  name.includes('-pipeline') ||
  name.includes('lead-created') ||
  name.includes('order-created') ||
  name.includes('product-') ||
  name.includes('record-order') ||
  name.includes('store-lms')
) {
  severity = 'warning';
}

return {
  json: {
    severity,
    isExecutionError: isExecution,
    isTriggerError: !isExecution,
    workflowId: wf.id || 'unknown',
    workflowName: wf.name || 'Unknown Workflow',
    workflowUrl,
    executionId: exec?.id ?? null,
    executionUrl: exec?.url ?? null,
    executionMode: exec?.mode ?? trig?.mode ?? 'unknown',
    retryOf: exec?.retryOf ?? null,
    lastNodeExecuted: exec?.lastNodeExecuted ?? trig?.error?.node?.name ?? 'unknown',
    errorMessage: exec?.error?.message ?? trig?.error?.message ?? 'Unknown error',
    errorDescription: exec?.error?.description ?? trig?.error?.description ?? '',
    errorStack: exec?.error?.stack ?? trig?.error?.cause?.stack ?? '',
    triggerCause: trig?.error?.cause?.message ?? null,
    timestamp: new Date().toISOString(),
    _raw: { execution: exec, trigger: trig, workflow: wf },
  }
};`,
  },
  {
    typeVersion: 2,
    position: [-160, 300],
    id: 'a1b2c3d4-0001-4000-8000-000000000001',
  }
);

// --- Self-Loop Check (IF) ---
// If the Error Handler itself failed, route to a minimal fallback to avoid loops.
const selfLoopCheck = createNode(
  'Self-Loop Check',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: false,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'a1b2c3d4-0002-4000-8000-000000000001',
          leftValue: '={{ $json.workflowName }}',
          rightValue: 'Error Handler',
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
  {
    typeVersion: 2.2,
    position: [80, 300],
    id: 'a1b2c3d4-0003-4000-8000-000000000001',
  }
);

// --- Fallback Pushover (self-loop) ---
const fallbackPushover = createNode(
  'Fallback Alert',
  'n8n-nodes-base.pushover',
  {
    userKey: PUSHOVER_USER_KEY,
    message: '=ERROR HANDLER ITSELF FAILED: {{ $json.errorMessage }}',
    priority: 2,
    additionalFields: {
      url: '={{ $json.workflowUrl }}',
    },
  },
  {
    typeVersion: 1,
    position: [320, 80],
    id: 'a1b2c3d4-0004-4000-8000-000000000001',
    credentials: PUSHOVER_CREDENTIAL,
  }
);

// --- Classify Severity (Switch) ---
const classifySeverity = createNode(
  'Classify Severity',
  'n8n-nodes-base.switch',
  {
    rules: {
      values: [
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
                id: 'a1b2c3d4-0005-4000-8000-000000000001',
                leftValue: '={{ $json.severity }}',
                rightValue: 'critical',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Critical',
        },
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
                id: 'a1b2c3d4-0006-4000-8000-000000000001',
                leftValue: '={{ $json.severity }}',
                rightValue: 'warning',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'Warning',
        },
      ],
    },
    options: {
      fallbackOutput: 'extra',
    },
  },
  {
    typeVersion: 3.2,
    position: [320, 400],
    id: 'a1b2c3d4-0007-4000-8000-000000000001',
  }
);

// ---------------------------------------------------------------------------
// HTML Email Template (shared across all severity levels)
// ---------------------------------------------------------------------------
const EMAIL_HTML = `<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    .header { padding: 16px 24px; color: #fff; }
    .header.critical { background: #d32f2f; }
    .header.warning { background: #f57c00; }
    .header.info { background: #1976d2; }
    .header h1 { margin: 0; font-size: 18px; }
    .body { padding: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    td { padding: 8px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
    td:first-child { font-weight: 600; width: 160px; color: #555; }
    a { color: #1976d2; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 600; color: #555; padding: 8px 0; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
    .error-msg { background: #fff3f3; border-left: 4px solid #d32f2f; padding: 12px 16px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header {{ $json.severity }}">
      <h1>{{ $json.severity.toUpperCase() }}: {{ $json.isExecutionError ? 'Execution' : 'Trigger' }} Error in {{ $json.workflowName }}</h1>
    </div>
    <div class="body">
      <div class="error-msg">{{ $json.errorMessage }}</div>

      <table>
        <tr><td>Workflow</td><td><a href="{{ $json.workflowUrl }}">{{ $json.workflowName }}</a> ({{ $json.workflowId }})</td></tr>
        <tr><td>Failed Node</td><td>{{ $json.lastNodeExecuted }}</td></tr>
        <tr><td>Error Type</td><td>{{ $json.isExecutionError ? 'Execution Error' : 'Trigger Error' }}</td></tr>
        <tr><td>Execution</td><td>{{ $json.executionUrl ? '<a href="' + $json.executionUrl + '">' + $json.executionId + '</a>' : 'N/A (trigger error)' }}</td></tr>
        <tr><td>Mode</td><td>{{ $json.executionMode }}</td></tr>
        <tr><td>Retry Of</td><td>{{ $json.retryOf || 'N/A' }}</td></tr>
        <tr><td>Timestamp</td><td>{{ $json.timestamp }}</td></tr>
        <tr><td>Severity</td><td>{{ $json.severity }}</td></tr>
      </table>

      {{ $json.errorDescription ? '<p><strong>Description:</strong> ' + $json.errorDescription + '</p>' : '' }}

      {{ $json.triggerCause ? '<p><strong>Trigger Cause:</strong> ' + $json.triggerCause + '</p>' : '' }}

      <details>
        <summary>Stack Trace</summary>
        <pre>{{ $json.errorStack || 'No stack trace available' }}</pre>
      </details>

      <details>
        <summary>Raw Error Data (JSON)</summary>
        <pre>{{ JSON.stringify($json._raw, null, 2) }}</pre>
      </details>
    </div>
  </div>
</body>
</html>`;

// --- Critical HTML ---
const htmlCritical = createNode(
  'Format Critical Email',
  'n8n-nodes-base.html',
  { html: EMAIL_HTML },
  {
    typeVersion: 1.2,
    position: [560, 100],
    id: 'a1b2c3d4-0010-4000-8000-000000000001',
  }
);

// --- Warning HTML ---
const htmlWarning = createNode(
  'Format Warning Email',
  'n8n-nodes-base.html',
  { html: EMAIL_HTML },
  {
    typeVersion: 1.2,
    position: [560, 460],
    id: 'a1b2c3d4-0011-4000-8000-000000000001',
  }
);

// --- Info HTML ---
const htmlInfo = createNode(
  'Format Info Email',
  'n8n-nodes-base.html',
  { html: EMAIL_HTML },
  {
    typeVersion: 1.2,
    position: [560, 820],
    id: 'a1b2c3d4-0012-4000-8000-000000000001',
  }
);

// --- Critical Email (eli + eve) ---
const emailCritical = createNode(
  'Email Critical',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: FROM_EMAIL,
    toEmail: TO_ALL,
    subject: '=[CRITICAL] Workflow Error: {{ $json.workflowName }} — {{ $json.lastNodeExecuted }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: { appendAttribution: false },
  },
  {
    typeVersion: 2.1,
    position: [800, 0],
    id: 'a1b2c3d4-0020-4000-8000-000000000001',
    credentials: SMTP_CREDENTIAL,
  }
);

// --- Critical Pushover (emergency, priority 2) ---
const pushoverCritical = createNode(
  'Pushover Critical',
  'n8n-nodes-base.pushover',
  {
    userKey: PUSHOVER_USER_KEY,
    message: '=CRITICAL: {{ $json.workflowName }} failed at "{{ $json.lastNodeExecuted }}" — {{ $json.errorMessage }}',
    priority: 2,
    additionalFields: {
      url: '={{ $json.executionUrl || $json.workflowUrl }}',
    },
  },
  {
    typeVersion: 1,
    position: [800, 200],
    id: 'a1b2c3d4-0021-4000-8000-000000000001',
    credentials: PUSHOVER_CREDENTIAL,
  }
);

// --- Warning Email (eli + eve) ---
const emailWarning = createNode(
  'Email Warning',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: FROM_EMAIL,
    toEmail: TO_ALL,
    subject: '=[WARNING] Workflow Error: {{ $json.workflowName }} — {{ $json.lastNodeExecuted }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: { appendAttribution: false },
  },
  {
    typeVersion: 2.1,
    position: [800, 360],
    id: 'a1b2c3d4-0022-4000-8000-000000000001',
    credentials: SMTP_CREDENTIAL,
  }
);

// --- Warning Pushover (high, priority 1) ---
const pushoverWarning = createNode(
  'Pushover Warning',
  'n8n-nodes-base.pushover',
  {
    userKey: PUSHOVER_USER_KEY,
    message: '=WARNING: {{ $json.workflowName }} failed at "{{ $json.lastNodeExecuted }}" — {{ $json.errorMessage }}',
    priority: 1,
    additionalFields: {
      url: '={{ $json.executionUrl || $json.workflowUrl }}',
    },
  },
  {
    typeVersion: 1,
    position: [800, 560],
    id: 'a1b2c3d4-0023-4000-8000-000000000001',
    credentials: PUSHOVER_CREDENTIAL,
  }
);

// --- Info Email (eli only) ---
const emailInfo = createNode(
  'Email Info',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: FROM_EMAIL,
    toEmail: TO_ELI,
    subject: '=[INFO] Workflow Error: {{ $json.workflowName }} — {{ $json.lastNodeExecuted }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: { appendAttribution: false },
  },
  {
    typeVersion: 2.1,
    position: [800, 820],
    id: 'a1b2c3d4-0024-4000-8000-000000000001',
    credentials: SMTP_CREDENTIAL,
  }
);

// --- Connections ---
const connections = [
  // Main spine
  connect(errorTrigger, normalize),
  connect(normalize, selfLoopCheck),

  // Self-loop: true branch (output 0) → fallback Pushover
  connect(selfLoopCheck, fallbackPushover, 0),

  // Normal flow: false branch (output 1) → severity classification
  connect(selfLoopCheck, classifySeverity, 1),

  // Critical (output 0) → HTML → Email + Pushover
  connect(classifySeverity, htmlCritical, 0),
  connect(htmlCritical, emailCritical),
  connect(htmlCritical, pushoverCritical),

  // Warning (output 1) → HTML → Email + Pushover
  connect(classifySeverity, htmlWarning, 1),
  connect(htmlWarning, emailWarning),
  connect(htmlWarning, pushoverWarning),

  // Info / fallback (output 2) → HTML → Email only
  connect(classifySeverity, htmlInfo, 2),
  connect(htmlInfo, emailInfo),
];

export default createWorkflow('Error Handler', {
  nodes: [
    errorTrigger,
    normalize,
    selfLoopCheck,
    fallbackPushover,
    classifySeverity,
    htmlCritical,
    htmlWarning,
    htmlInfo,
    emailCritical,
    pushoverCritical,
    emailWarning,
    pushoverWarning,
    emailInfo,
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
