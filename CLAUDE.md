# N8N Workflows Project

## What This Is
A Node.js project for programmatically defining n8n workflows in JavaScript. Each workflow is a `.js` file in `workflows/` that exports an n8n workflow JSON object. A build script compiles them to importable JSON in `output/`.

## Target Environment
- **n8n server**: self-hosted at `https://n8n.vennfactory.com`
- **n8n version**: 1.122.5
- **Full host control**: we own the server and can install any packages or community nodes

## Deployment Model
Workflows are built locally to `output/*.json`, then deployed to the n8n server via the API using `push-workflows.js`. All commands require 1Password CLI (`op run`) for secrets.

## Project Structure
```
workflows/        # Workflow definitions (one .js file per workflow)
output/           # Generated n8n JSON (gitignored, created by build)
server/           # Snapshots pulled from the live n8n server (for reference/backup)
lib/              # Shared helpers (workflow builder, node factories, adapter template)
build.js          # Build script: compiles workflows/ -> output/
push-workflows.js # Deploy built workflows to n8n server
pull-workflows.js # Download workflows from n8n server to server/
activate-workflows.js    # Activate workflows on n8n server
deactivate-workflows.js  # Deactivate workflows on n8n server
maintenance.js           # Toggle maintenance mode via Redis
setup-qstash-topics.js   # Configure QStash URL Groups + Redis topic mappings
patch-router*.js         # One-off scripts that patch the Notion Webhook Router in-place
```

## Conventions
- **Language**: JavaScript (ES modules, `"type": "module"` in package.json)
- **File naming**: `kebab-case.js` for workflow files (e.g., `sync-github-issues.js`)
- **One workflow per file**: each file has a single `export default createWorkflow(...)` call
- **No TypeScript**: plain JS only
- **Known-safe npm packages are allowed**: install as needed with `npm install`

## Building
```sh
op run --env-file=.env.tpl -- node build.js                    # build all workflows
op run --env-file=.env.tpl -- node build.js --workflow my-flow  # build one (omit .js extension)
```
Output lands in `output/<workflow-name>.json`, ready to import into n8n.

Secrets are managed via 1Password CLI (`op`). The `.env.tpl` file contains `op://` references — no plaintext secrets on disk. The 1Password desktop app must be unlocked for `op run` to work.

## CLI Tools

All tools use 1Password CLI for secrets. Prefix every command with `op run --env-file=.env.tpl --`.

### `push-workflows.js` — Deploy to n8n server
Pushes built JSON from `output/` to the n8n server. Matches by workflow name: updates existing, creates new.
```sh
op run --env-file=.env.tpl -- node push-workflows.js                        # push all
op run --env-file=.env.tpl -- node push-workflows.js --workflow my-flow     # push one (omit .json)
op run --env-file=.env.tpl -- node push-workflows.js --dry-run              # preview
```

### `pull-workflows.js` — Download from n8n server
Downloads all workflows from the server to `server/` as JSON snapshots. Skips unchanged workflows.
```sh
op run --env-file=.env.tpl -- node pull-workflows.js              # pull all (skip unchanged)
op run --env-file=.env.tpl -- node pull-workflows.js --force      # re-download all
op run --env-file=.env.tpl -- node pull-workflows.js --list       # list server workflows
```

### `activate-workflows.js` / `deactivate-workflows.js` — Toggle workflow activation
```sh
op run --env-file=.env.tpl -- node activate-workflows.js                       # activate all adapters
op run --env-file=.env.tpl -- node activate-workflows.js --workflow my-flow    # activate one
op run --env-file=.env.tpl -- node activate-workflows.js --all                 # activate ALL built
op run --env-file=.env.tpl -- node activate-workflows.js --dry-run             # preview
```
Same flags for `deactivate-workflows.js`.

### `maintenance.js` — Maintenance mode
Toggles maintenance mode via Upstash Redis. When active, the Notion Webhook Router and Mailchimp Audience Hook accept webhooks (200 OK) but silently drop all events.
```sh
op run --env-file=.env.tpl -- node maintenance.js on               # enable
op run --env-file=.env.tpl -- node maintenance.js on --ttl 3600    # enable with 1-hour auto-expire
op run --env-file=.env.tpl -- node maintenance.js off              # disable
op run --env-file=.env.tpl -- node maintenance.js status           # check current state
```

### `setup-qstash-topics.js` — Configure QStash routing
Creates QStash URL Groups (topics), registers adapter webhook endpoints, and writes database-ID-to-topic-name mappings to Redis so the router can look up the correct topic at runtime.
```sh
op run --env-file=.env.tpl -- node setup-qstash-topics.js              # apply
op run --env-file=.env.tpl -- node setup-qstash-topics.js --dry-run    # preview
```

### `patch-router*.js` — One-off router patches
These scripts modify the Notion Webhook Router directly on the server (fetch → patch → push). They are **idempotent** — safe to re-run.
- **`patch-router.js`** — Wires pipeline sub-workflows (Sales, Partner, Comms) into the router Switch
- **`patch-router-maintenance.js`** — Inserts maintenance mode gate between Webhook and Calculate Signature
- **`patch-router-debounce.js`** — Inserts Redis debounce gate (SET NX EX 10) between Skip Deleted Events and Sort by Timestamp
- **`patch-router-qstash.js`** — Replaces the debounce gate + Switch fan-out with Redis pipeline + QStash publish
- **`patch-router-secret.js`** — Updates the Notion webhook verification secret in Calculate Signature from `NOTION_WEBHOOK_SECRET` env var

```sh
op run --env-file=.env.tpl -- node patch-router-debounce.js              # apply
op run --env-file=.env.tpl -- node patch-router-debounce.js --dry-run    # preview
```

### Common workflow: build + deploy
```sh
op run --env-file=.env.tpl -- node build.js && op run --env-file=.env.tpl -- node push-workflows.js
```

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

## Secrets Management
Secrets are managed via **1Password CLI** (`op run`). The `.env.tpl` file contains `op://` references — no plaintext secrets on disk. The 1Password desktop app must be unlocked for `op run` to work.

Key secrets in `.env.tpl`:
- `N8N_API_KEY` / `N8N_BASE_URL` — n8n server API access
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (debounce, maintenance mode)
- `QSTASH_URL` / `QSTASH_TOKEN` — QStash delayed delivery
- `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` — QStash JWT signature verification
- `MAILCHIMP_WEBHOOK_SECRET` — Shared secret for Mailchimp webhook validation
- `MAILCHIMP_DC` — Mailchimp data center (for admin profile URLs)
- `ANTHROPIC_API_KEY` — Anthropic API (used by some workflows)
- `NOTION_WEBHOOK_SECRET` — Notion webhook signature verification (used by patch-router-secret.js)
- `WEBFLOW_VERIFICATION_KEY` — Webflow webhook verification

## Shared Libraries

### `lib/workflow.js` — Workflow builder helpers
`createWorkflow`, `createNode`, `connect` — see "How to Define a Workflow" section.

### `lib/load-env.js` — Environment loader
Loads from `.env` file if present, otherwise falls back to `process.env` (for `op run` injection).

### `lib/adapter-template.js` — QStash adapter template
Factory function for creating Notion webhook adapter workflows. Each adapter receives QStash callbacks, verifies the JWT signature, formats the payload for a specific Notion database, and upserts via the shared `upsert-contact` sub-workflow.

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

## Notion Contacts Database
Many workflows interact with the master contacts database in Notion.

- **Database ID**: `1688ebaf-15ee-806b-bd12-dd7c8caf2bdd`
- **Lookup field**: `Identifier` (title property, contains the email address)
- **Notion node version**: use `typeVersion: 2.2`

### Property names and assumed types
| Notion Property   | Type          | Incoming field     |
|-------------------|---------------|--------------------|
| Identifier        | title         | email              |
| Email             | email         | email              |
| First name        | rich_text     | first_name         |
| Last name         | rich_text     | last_name          |
| Company Name      | rich_text     | company            |
| Email Marketing   | select        | email_marketing    |
| Tags              | multi_select  | tags (string[])    |
| Street Address    | rich_text     | street_address     |
| Address Line 2    | rich_text     | street_address_2   |
| City              | rich_text     | city               |
| State             | rich_text     | state              |
| Postal Code       | rich_text     | postal_code        |
| Country           | rich_text     | country            |
| Phone             | phone_number  | phone              |

### Upsert pattern
The `upsert-contact` sub-workflow implements the standard contact upsert:
1. Filter node validates email is present — records without email are dropped
2. Lookup by Identifier (email) with `alwaysOutputData: true` on the Notion node
3. IF node checks whether `$json.id` exists (Notion page ID)
4. True branch: Code node merges incoming + existing (non-null incoming wins), then Notion Update
5. False branch: Notion Create with incoming data

Other workflows that modify contacts should call the upsert sub-workflow rather than writing to Notion directly.

## Guidelines for Claude
- **Always check `LESSONS.md`** before designing solutions — it contains hard-won knowledge about n8n parameter formats and import quirks
- **Always record new lessons** in `LESSONS.md` when a bug is found, a workaround is discovered, or something behaves differently than expected
- Always use `lib/workflow.js` helpers to build workflows — never hand-write raw JSON
- Test builds with `node build.js` after creating or modifying workflows
- Node type IDs must match n8n 1.x naming (e.g., `n8n-nodes-base.httpRequest`, not legacy names)
- Use `typeVersion` in opts when a node has multiple versions (check n8n docs for the correct version)
- Keep workflow files focused: one automation per file
- Prefer descriptive node names that explain what the node does
- Use `connect()` for all wiring — it handles n8n's nested connection format
- Extra node properties (like `settings`, `onError`) can be added directly to the node object after `createNode()` returns
- For sub-workflows, use `n8n-nodes-base.executeWorkflowTrigger` as the entry point
- For IF node v2, use the `conditions.conditions[].operator` structure with `{ type, operation, singleValue }`
- After import, Notion nodes will need their credential connected and property mappings verified in the n8n UI

## Git Workflow
- We are the only ones working in this repo — push directly to `origin/master` (no PRs needed)
- Commit and push when the user asks, or when a logical unit of work is complete
