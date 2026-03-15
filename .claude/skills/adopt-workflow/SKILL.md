---
name: adopt-workflow
description: >
  Adopt a server-only n8n workflow into the local codebase. Use this skill whenever:
  the user wants to "adopt", "implement", "migrate", or "bring in" a workflow from
  the n8n server; the user references a workflow from the "To Implement" section of
  workflow-catalog.md; or the user asks to create a local .js implementation of a
  server workflow. Takes a workflow name as an argument (kebab-case, no extension).
  Also trigger when the user says things like "let's do the next workflow" or
  "adopt appearances-management".
---

# Adopt Workflow

This skill takes a workflow that exists only on the n8n server (as a JSON snapshot in `server/`) and creates a local `.js` implementation in `workflows/` that, when built, produces output identical to the server original.

## Prerequisites

Before starting, read `LESSONS.md` — it contains critical information about n8n parameter formats, node quirks, and import compatibility that will save you from common mistakes.

## Arguments

The skill takes one argument: the workflow name in kebab-case (no `.js` or `.json` extension). Example: `adopt-workflow appearances-management`

If no argument is provided, ask the user which workflow to adopt. You can reference `workflow-catalog.md` for the list of workflows marked "To Implement".

## Procedure

### Step 1: Pull the latest snapshot from the server

Refresh the server snapshot to make sure you're working against the current live version:

```bash
op run --env-file=.env.tpl -- node pull-workflows.js --force
```

Then confirm the target file exists in `server/`. The server filename may not exactly match the workflow name — check `workflow-catalog.md` for known filename mismatches.

### Step 2: Study the server workflow

Read the JSON file from `server/<workflow-name>.json`. Understand:

- **Workflow name** (`name` field) — your `.js` file must produce this exact name
- **Nodes** — each node's `name`, `type`, `typeVersion`, `position`, `parameters`, `credentials`, `disabled`, `onError`, and any other top-level node properties (`retryOnFail`, `maxTries`, `waitBetweenTries`, `alwaysOutputData`, `executeOnce`, `notesInFlow`, `notes`)
- **Connections** — how nodes wire together, including non-main connection types (`ai_languageModel`, etc.), multi-output nodes, and multi-input nodes
- **Workflow settings** — `executionOrder`, `errorWorkflow`, `callerPolicy`, `timezone`, etc.
- **Tags** — preserve any tags on the workflow

Pay special attention to:
- Resource locator patterns (`__rl: true` with `mode` and `value`)
- Nested parameter structures (e.g., `conditions.conditions[]`, `propertiesUi.propertyValues[]`, `rules.values[]`)
- Credential references (preserve exact `id` and `name`)
- `webhookId` values on webhook nodes (must match for URL stability)
- Sticky notes (`n8n-nodes-base.stickyNote`) — include them as nodes

### Step 3: Create the .js workflow file

Create `workflows/<workflow-name>.js` using the project's helpers:

```js
import { createWorkflow, createNode, connect } from '../lib/workflow.js';
```

Guidelines:
- **ES modules** — use `import`/`export default`
- **kebab-case filename** — matching the server JSON filename
- **One workflow per file** — single `export default createWorkflow(...)` call
- **Explicit positions** — always pass `position: [x, y]` in opts to match the server layout exactly
- **Explicit IDs** — pass `id` in opts matching the server node IDs, so the workflow can be pushed back without creating duplicate nodes
- **Preserve node names exactly** — names are used in connection wiring and expression references (`$('Node Name')`)
- **Preserve typeVersion** — always specify `typeVersion` matching the server
- **Add top-level node properties after createNode** — for properties like `onError`, `retryOnFail`, `maxTries`, `waitBetweenTries`, `alwaysOutputData`, `executeOnce`, `notesInFlow`, `notes`, assign them directly on the node object after `createNode()` returns (e.g., `node.onError = 'continueRegularOutput'`)
- **Sticky notes** — create them with `createNode` using type `n8n-nodes-base.stickyNote` and include `width` and `height` in parameters

### Step 4: Build

```bash
op run --env-file=.env.tpl -- node build.js --workflow <workflow-name>
```

This writes `output/<workflow-name>.json`.

### Step 5: Compare

Compare the built output against the server original. Write and run a comparison script or use inline diffing. Focus on **functional equivalence**:

**Must match exactly:**
- Node count
- Each node's `name`, `type`, `typeVersion`
- Each node's `position` (x, y coordinates)
- Each node's `parameters` (deep equality, including nested structures)
- Each node's `credentials` (if any)
- Each node's top-level properties: `disabled`, `onError`, `retryOnFail`, `maxTries`, `waitBetweenTries`, `alwaysOutputData`, `executeOnce`, `notesInFlow`, `notes`, `webhookId`
- Connection topology (which nodes connect to which, via which outputs/inputs/types)
- Workflow `name`
- Workflow `settings`
- Workflow `tags`

**OK to differ:**
- Node `id` values (generated UUIDs)
- Envelope fields: `id`, `versionId`, `createdAt`, `updatedAt`, `active`
- `meta`, `staticData`, `pinData` (envelope metadata)
- Key ordering within objects

### Step 6: Fix and rebuild

If mismatches are found:

1. Identify the specific differences
2. Trace each back to the `.js` source
3. Fix the source
4. Rebuild and re-compare

Common issues to watch for (see LESSONS.md for details):
- Missing `__rl: true` wrapper on resource locator fields (databaseId, pageId, workflowId)
- Wrong value field names in Notion filter conditions or propertiesUi
- Missing `typeValidation: 'strict'` in Filter/IF node conditions
- `singleValue: true` missing on unary operators (`exists`, `notEmpty`, `true`)
- Missing `options: {}` on nodes that require it
- Forgetting `richText: false` on rich_text properties in propertiesUi
- Position mismatch from auto-increment (always pass explicit positions)

Repeat the build-compare-fix loop until there are zero functional differences. If you cannot resolve a mismatch after 5 iterations, stop and report the specific issue to the user.

### Step 7: Present results and ask permission

Once the built output matches the server original, show the user:
- A summary of the workflow (what it does, how many nodes, key integrations)
- The new `.js` file path
- Confirmation that build output matches the server snapshot

Then ask for permission to:
1. Commit the new workflow file to git
2. Push it to the n8n server via `push-workflows.js`

Do NOT commit or push without explicit user approval.

After committing, update `workflow-catalog.md` to move the workflow from "To Implement" to "Implemented Locally".

## Comparison Script Pattern

Here's a useful inline comparison approach:

```bash
node -e "
const fs = require('fs');
const server = JSON.parse(fs.readFileSync('server/<name>.json', 'utf8'));
const built = JSON.parse(fs.readFileSync('output/<name>.json', 'utf8'));

// Compare nodes
const sNodes = [...server.nodes].sort((a,b) => a.name.localeCompare(b.name));
const bNodes = [...built.nodes].sort((a,b) => a.name.localeCompare(b.name));

console.log('Node count:', sNodes.length, 'vs', bNodes.length);

for (let i = 0; i < Math.max(sNodes.length, bNodes.length); i++) {
  const s = sNodes[i], b = bNodes[i];
  if (!s) { console.log('EXTRA built node:', b?.name); continue; }
  if (!b) { console.log('MISSING built node:', s?.name); continue; }
  if (s.name !== b.name) console.log('Name mismatch:', s.name, 'vs', b.name);
  if (s.type !== b.type) console.log(s.name, 'type:', s.type, 'vs', b.type);
  if (s.typeVersion !== b.typeVersion) console.log(s.name, 'typeVersion:', s.typeVersion, 'vs', b.typeVersion);
  if (JSON.stringify(s.position) !== JSON.stringify(b.position)) console.log(s.name, 'position:', s.position, 'vs', b.position);
  if (JSON.stringify(s.parameters) !== JSON.stringify(b.parameters)) console.log(s.name, 'PARAMETERS DIFFER');
  if (JSON.stringify(s.credentials) !== JSON.stringify(b.credentials)) console.log(s.name, 'CREDENTIALS DIFFER');
}

// Compare connections
if (JSON.stringify(server.connections) !== JSON.stringify(built.connections)) {
  console.log('CONNECTIONS DIFFER');
}
console.log('Done.');
"
```

For deeper parameter diffing, use `JSON.stringify(s.parameters, null, 2)` and compare line by line.
