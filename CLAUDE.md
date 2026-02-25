# N8N Workflows Project

## What This Is
A Node.js project for programmatically defining n8n workflows in JavaScript. Each workflow is a `.js` file in `workflows/` that exports an n8n workflow JSON object. A build script compiles them to importable JSON in `output/`.

## Target Environment
- **n8n server**: self-hosted at `https://n8n.vennfactory.com`
- **n8n version**: 1.122.5
- **Full host control**: we own the server and can install any packages or community nodes

## Deployment Model
- **JSON export only** — workflows are built to `output/*.json` and manually imported into n8n via the UI or CLI
- No programmatic API deployment; no API key or auth integration needed in this project

## Project Structure
```
workflows/   # Workflow definitions (one .js file per workflow)
output/      # Generated n8n JSON (gitignored, created by build)
lib/         # Shared helpers (workflow builder, node factories)
build.js     # Build script: compiles workflows/ -> output/
```

## Conventions
- **Language**: JavaScript (ES modules, `"type": "module"` in package.json)
- **File naming**: `kebab-case.js` for workflow files (e.g., `sync-github-issues.js`)
- **One workflow per file**: each file has a single `export default createWorkflow(...)` call
- **No TypeScript**: plain JS only
- **Known-safe npm packages are allowed**: install as needed with `npm install`

## Building
```sh
node build.js                          # build all workflows
node build.js --workflow my-flow       # build one (omit .js extension)
```
Output lands in `output/<workflow-name>.json`, ready to import into n8n.

## How to Define a Workflow
Use the helpers from `lib/workflow.js`:

```js
import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const trigger = createNode('Schedule Trigger', 'n8n-nodes-base.scheduleTrigger', {
  rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
});

const http = createNode('HTTP Request', 'n8n-nodes-base.httpRequest', {
  url: 'https://api.example.com/data',
  method: 'GET',
});

export default createWorkflow('My Workflow', {
  nodes: [trigger, http],
  connections: [connect(trigger, http)],
});
```

### `createNode(name, type, parameters, opts?)`
- `name` — display name on the n8n canvas
- `type` — n8n node type ID (e.g., `'n8n-nodes-base.httpRequest'`)
- `parameters` — node-specific config object
- `opts` — optional: `{ typeVersion, position, credentials, disabled, id }`

### `connect(from, to, fromOutput?, toInput?, fromType?)`
- Links two nodes; defaults to output 0 → input 0, type `'main'`

### `createWorkflow(name, { nodes, connections, active?, settings?, tags? })`
- Assembles the final n8n JSON; `active` defaults to `false`

## Primary Use Case
Event-driven automations (webhooks, schedules, triggers) integrating a wide variety of services: HTTP/webhooks, databases (Postgres, MySQL, MongoDB), and SaaS APIs (Slack, Google Sheets, GitHub, etc.).

## Credentials
Credentials are **not** stored in this project. n8n credentials are managed directly on the server. When a node needs credentials, reference them by name in `opts.credentials`:
```js
createNode('Slack', 'n8n-nodes-base.slack', { channel: '#general', text: 'Hello' }, {
  credentials: { slackApi: { id: 'xxx', name: 'My Slack Credential' } },
});
```
The actual credential IDs/names must match what's configured in n8n.

## Guidelines for Claude
- Always use `lib/workflow.js` helpers to build workflows — never hand-write raw JSON
- Test builds with `node build.js` after creating or modifying workflows
- Node type IDs must match n8n 1.x naming (e.g., `n8n-nodes-base.httpRequest`, not legacy names)
- Use `typeVersion` in opts when a node has multiple versions (check n8n docs for the correct version)
- Keep workflow files focused: one automation per file
- Prefer descriptive node names that explain what the node does
- Use `connect()` for all wiring — it handles n8n's nested connection format
