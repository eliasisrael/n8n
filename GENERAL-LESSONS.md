# n8n Workflow Lessons

General knowledge for building and importing n8n workflows programmatically. Hard-won lessons from real-world usage of n8n 1.x.

---

## Canvas Node Positioning

### General principles
- n8n canvas coordinates are `[x, y]` where **x increases rightward** and **y increases downward**
- Nodes on the same logical step should share the same x coordinate; sequential steps increase x
- Typical horizontal spacing between sequential nodes: **200–250px**
- Don't place all nodes on a single y line — use vertical offsets to convey branching and hierarchy
- **Left-to-right flow**: if node A has an output arc that traces to node B, A must be placed to the left of B (lower x)
- **Output ordering top-to-bottom**: when a node has multiple outputs, all downstream nodes connected from output 0 must be placed above (lower y) those from output 1, which in turn must be above those from output 2, and so on
- **Minimize arc crossings**: arrange nodes so that output arcs do not cross whenever possible

### Layout patterns for webhook routers
- **Validation spine** (webhook → signature check → filters): keep on a single y level, tight x spacing (~224px)
- **Processing chain** (code → HTTP → code): can step y down slightly (+72px) to visually distinguish from the validation spine, then step back up at the next decision point
- **Decision/fan-out nodes** (IF → downstream): step y down progressively (e.g., 528 → 624 → 696) to create a cascading staircase that shows the flow direction
- **Parallel branches** (e.g., Execution Data): same x as the node they branch from, offset y by ~-192 (above)
- **Terminal nodes** (Success/Error respond): align at the **same x** coordinate, spread vertically (e.g., y=192 for success, y=816 for error) so they form a clear vertical pair at the right edge of the workflow
- **Error paths**: position below the main flow line; success paths above

### Parallel branch placement
- When a node receives input from sources at x=N (e.g., two Build nodes), place it at x=N+224 — the **same x** as sibling nodes that also receive from those sources
- **Vertically center** a shared downstream node between its sources (e.g., if Update is at y=208 and Create is at y=592, place the shared node at y=400)
- A parallel observability/monitoring branch should sit at the **vertical midpoint** between the branches it monitors, not below or offset — this visually conveys that it connects to both

### Hardcode positions in patch scripts
- When patching a live workflow, **hardcode absolute positions** rather than computing relative offsets. Relative layouts drift across re-runs as anchor nodes move.
- After manually adjusting layout in the n8n UI, fetch the live positions with the API and copy them into the patch script so re-runs are idempotent.

### Workflow canvas layout conventions
When placing nodes programmatically (via the API or in workflow JS files), follow these layout rules to keep the canvas readable:

- **Horizontal spacing: 224px** between consecutive nodes in a chain. This is the standard grid increment.
- **When inserting a node into an existing chain**, shift **all** downstream nodes to the right by 224px. Never squeeze a node into an existing gap — it crowds the canvas and overlaps connection arcs.
- **Same-chain nodes share a y-coordinate.** Keep horizontally connected nodes on the same row to maintain visual alignment.
- **Parallel branches need y-separation.** When a node forks into multiple paths (e.g., IF true/false, or a node with multiple outputs), offset each branch vertically by at least **200px** so nodes and connection arcs don't overlap. Example: a backup branch at y=100 and an execution branch at y=400.
- **Sticky notes go above the relevant node.** Position the sticky ~240px above (lower y value) with its x roughly aligned to the node it annotates. Use `color: 4` (yellow) for warnings/explanations. Typical size: 340×170.

---

## JSON Import Compatibility

### Workflow envelope must include extra fields
The workflow JSON must include `staticData: null`, `pinData: {}`, `meta: { templateCredsSetupCompleted: true }`, and tags as `{ name: "..." }` objects (not plain strings). Without these, n8n may reject the file or behave unexpectedly on import.

### Execute Workflow node requires typeVersion 1.2
- `n8n-nodes-base.executeWorkflow` with `typeVersion: 1` shows "This workflow is out of date" in the n8n UI
- Use `typeVersion: 1.2` for the current version

### Execute Workflow node: 0 items breaks downstream Respond to Webhook
- When a sub-workflow's filter drops all items, the Execute Workflow node outputs 0 items
- n8n does not execute downstream nodes when a node outputs 0 items — the chain stops
- In webhook adapters using `responseMode: 'responseNode'`, this means the Respond to Webhook node never fires, and the caller (e.g., QStash) sees a timeout and retries
- Fix: set `alwaysOutputData: true` on the Execute Workflow node so it always emits at least one item, ensuring the response node executes

### Execute Sub-workflow Trigger (v1.1) parameter names
- The input mode selector is **`inputSource`** (not `inputDataMode`)
- Valid values: `"jsonExample"`, `"workflowInputs"`, `"passthrough"`
- The JSON content field is **`jsonExample`** (a string containing JSON)
- `typeVersion` must be `1.1` for input modes to work at all
- The `defineBelow` / `workflowInputs` mode has a known bug where fields don't render on JSON import; use `jsonExample` mode instead

### Execute Workflow v1.2 needs `workflowInputs` when target uses typed inputs
When a sub-workflow's trigger uses `inputSource: 'jsonExample'` (which defines expected field names and types), the calling Execute Workflow node **must** include `workflowInputs` — not just `options: {}`. Without it, the sub-workflow receives no data (all fields are undefined).

Required structure:
```json
"workflowInputs": {
  "mappingMode": "defineBelow",
  "value": {
    "FieldName": "={{ $json.sourceField }}",
    "AnotherField": "={{ $json[\"Source Field\"] }}"
  },
  "matchingColumns": [],
  "schema": [
    {
      "id": "FieldName",
      "displayName": "FieldName",
      "required": false,
      "defaultMatch": false,
      "display": true,
      "canBeUsedToMatch": true,
      "type": "string"
    }
  ],
  "attemptToConvertTypes": false,
  "convertFieldsToString": true
}
```

The `schema` array must list every field the sub-workflow expects, with matching `id`/`displayName`. The `value` object maps each schema field to an expression that reads from the current item's JSON. Field names in `value` must match the schema `id` values exactly (including typos in legacy schemas).

### Filter & IF node (v2) condition structure
- `conditions.options` **must** include `typeValidation: 'strict'` — without it, conditions may not render after import
- Operator names must match n8n internals exactly:
  - `notEmpty` (not `isNotEmpty`)
  - `empty` (not `isEmpty`)
  - `exists` / `notExists`
  - `equals` / `notEquals`
  - `contains` / `notContains`
  - `startsWith` / `endsWith` (and their `not` variants)
  - `regex` / `notRegex`
- Operators with `singleValue: true` (like `exists`, `notEmpty`) don't need a `rightValue`
- **Boolean "is true" checks**: n8n's boolean operators (`operation: 'equals'`, `operation: 'true'`) are unreliable when the field may be undefined/missing — they can evaluate to true for undefined values. Even wrapping the expression in `=== true` at the expression level is not sufficient. The reliable pattern is to use **multiple AND conditions** that first test field existence, then test the value:
  ```js
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
    conditions: [
      // 1. Field exists
      { leftValue: '={{ $json.myField }}', rightValue: '',
        operator: { type: 'boolean', operation: 'exists', singleValue: true } },
      // 2. Field is true
      { leftValue: '={{ $json.myField }}', rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true } },
    ],
    combinator: 'and',
  }
  ```
  The `exists` check gates the `true` check — if the field is missing, the AND short-circuits to false. For object fields (e.g., a JSON body), use `type: 'object'` with `operation: 'exists'` + `operation: 'notEmpty'` to confirm the field is present and non-empty

---

## Code Nodes

### Code node execution mode matters
- `runOnceForAllItems` processes all items in one execution; use `$('Node').first().json` and `$input.first().json`; return an array `[{ json: ... }]`
- `runOnceForEachItem` processes each item individually; use `$json` for the current item and `$('Node').item.json` for paired items; return a single `{ json: ... }` object
- **Item pairing breaks across data-replacing nodes**: In `runOnceForEachItem` mode, `$('Node').item` pairs items by index. If an intermediate node (like a Notion lookup) replaces the data entirely, the pairing between the original trigger output and the current item breaks — `$('Node').item.json` will return empty/null data
- **`$('NodeName')` back-references are unreliable in the Code node sandbox**: The Code node's JavaScript sandbox may not support `$('NodeName').all()` or `$('NodeName').first()` the same way n8n's expression engine does. Calling `$('Receive Contact').first()` produced `"Property first does not exist on type"`, and `$('Receive Contact').all()` silently returned empty data. **Workaround**: use an n8n **Merge node** (v3, `combineByPosition`) to pair the original data with the downstream data before the Code node, so `$input.all()` contains everything the Code node needs — no back-references required
- **When item pairing breaks, use a Merge node**: Instead of trying to reconstruct the pairing with `$('Trigger Node').all()` in a Code node (which may fail silently), use an n8n Merge node to explicitly combine the two data streams. Wire the original data (e.g., from a Filter node) into the Merge node's second input alongside the transformed data (e.g., from an IF TRUE branch) on the first input

### Code nodes CANNOT have credentials
The `n8n-nodes-base.code` node type does **not** define any credential types. Attempting to attach credentials (e.g., `credentials: { notionApi: { id: '...', name: '...' } }`) causes a runtime error: `"Node type 'n8n-nodes-base.code' does not have any credentials defined"`. The `this.helpers.httpRequestWithAuthentication` method is therefore **not available** in Code nodes.

**Workaround**: Move authenticated API calls into a separate **HTTP Request** node (v4.2) with `authentication: 'predefinedCredentialType'` + `nodeCredentialType: 'notionApi'`. For paginated queries, use the HTTP Request node's built-in pagination (`paginationMode: 'updateAParameterInEachRequest'`). Use a Merge node (append mode) to combine the HTTP response data with other data streams before feeding into a Code node for processing.

### `fetch()` is not available in n8n Code nodes
The n8n Code node sandbox does **not** expose the global `fetch()` function. Attempting `await fetch(...)` fails with `fetch is not defined`. Built-in Node.js modules via `require()` (like `crypto`, `url`) work, but HTTP calls must use:
- An **HTTP Request node** (preferred) — wire it before/after the Code node
- `require('https')` with manual promise wrapping (fragile, not recommended)

When an HTTP Request node replaces `$json` with the API response, use a downstream Code node with a back-reference like `$('OriginalNode').item.json` to restore the original payload.

---

## General Patterns

### Webhook receivers must guarantee a response on every code path
When a workflow uses `responseMode: 'responseNode'`, every possible execution path **must** terminate at a Respond to Webhook node. If any path can silently end without responding (due to 0-item propagation, filtered-out items, or error branches that don't respond), the caller gets a timeout instead of an HTTP response. For external callers with retry logic (QStash, Mailchimp, etc.), this causes spurious retries.

**Common violations to check when building or reviewing webhook receivers:**
- A node between the webhook and the response can output 0 items (e.g., Execute Workflow when the sub-workflow filters everything, or a Filter node that drops all items). Fix: `alwaysOutputData: true` on such nodes.
- An error branch that doesn't have its own Respond node — the workflow errors out and the caller never gets a response. Fix: add Respond nodes on error paths (e.g., Respond 401, Respond 500).
- `retryOnFail` on Execute Workflow nodes in a webhook receiver — sub-workflow retries can take seconds each, delaying the response and potentially causing the caller to time out. When the caller already has retry logic (e.g., QStash), let it handle retries instead. Node-level retries on other nodes (e.g., HTTP Request for a quick API call) are fine since they complete fast and avoid burning a full caller retry cycle.

### Use Filter nodes instead of IF nodes for simple validation gates
When you only need to drop records that fail a check (no logic needed on the failing branch), use a Filter node. An IF node with an empty false branch is wasteful. Note: Filter nodes **silently drop** non-matching items — they don't error. The `onError` setting only fires on expression evaluation failures, not on items that fail the conditions. If you need to raise an error on invalid data, use an IF node with a Stop and Error node on the false branch instead (see below).

### Validate data shape defensively with IF + Stop and Error
When a branch assumes items have a specific shape (e.g., required fields for API calls), don't assume — validate. Use an IF node to check the required fields exist and are non-empty (using the `exists` + `notEmpty` AND pattern), then route failures to a **Stop and Error** node (`n8n-nodes-base.stopAndError`, v1). This halts the workflow and triggers the error workflow so malformed items are surfaced, not silently swallowed or sent to APIs with undefined data.

```js
createNode('Throw Invalid Item', 'n8n-nodes-base.stopAndError', {
  errorMessage: 'Item missing required fields.',
}, { position: [x, y], typeVersion: 1 });
```

**Why not a Filter node?** Filter silently drops non-matching items — that's not an error condition, it's quiet data loss. `onError: 'stopWorkflow'` on a Filter only fires on expression evaluation errors, not on items that fail the conditions.

**Why not a Code node with `throw`?** The Stop and Error node is n8n's purpose-built tool for halting with a custom error. It's cleaner and shows the correct error icon on the canvas.

### Use IF nodes to skip expensive operations when the pipeline is empty
When a workflow branch may produce zero items (e.g., all items filtered out), use an IF node to check for a sentinel value (like `_empty: true`) and bypass expensive operations (API calls, LLM invocations) on the false branch. This is cheaper and faster than sending dummy requests to external APIs. Pattern: Code node returns `{ _empty: true }` when empty → IF node checks `_empty notEquals true` → true branch proceeds normally, false branch skips directly to the next convergence point.

### Maintenance mode gate pattern
A Redis-based maintenance mode that silently drops events while returning 200 to callers:

```
Webhook → HTTP Request (GET maintenance key from Redis) → IF result empty
  True  → Restore Event (Code: back-ref to Webhook node) → normal processing
  False → Respond to Webhook (200, drop event)
```

The HTTP Request replaces $json, so the Restore Event node is essential to pass original webhook data downstream.

---

## Notion Node (n8n built-in)

### `databaseId` and `pageId` use the resource locator pattern
The Notion node v2 (typeVersion 2.2) defines `databaseId` and `pageId` as `resourceLocator` type parameters. A plain string value (e.g., `"databaseId": "abc123"`) is silently ignored on import — the database/page appears blank in the UI.

The correct format wraps the value in an object with `__rl: true`:
```json
"databaseId": {
  "__rl": true,
  "mode": "id",
  "value": "1688ebaf-15ee-806b-bd12-dd7c8caf2bdd"
}
```

Supported modes:
- `"id"` — raw UUID (with or without dashes), best for programmatic use
- `"url"` — full Notion URL, the value is extracted via regex
- `"list"` — selected from the UI dropdown; also carries `cachedResultName` and `cachedResultUrl`

This applies to all operations: `create`, `getAll`, `get`, and `update` (for `pageId`).

Expressions work inside the `value` field: `"value": "={{ $json.pageId }}"`.

### Notion node v2 getAll filter structure (databasePage)
The Notion node v2.2 `getAll` operation on `databasePage` uses a **completely different filter system** from the v1 node. The v1 node uses a `filter` parameter with `singleCondition`/`multipleCondition`. The v2 node uses `filterType` + `matchType` + `filters`.

**`filterType` valid values** (v2 only, hidden for v1):
- `"none"` — no filtering (default)
- `"manual"` — build conditions in the UI
- `"json"` — raw JSON filter (stored in `filterJson` parameter)

**`matchType`** (only shown when `filterType` is `"manual"`):
- `"anyFilter"` — OR logic (any condition can match)
- `"allFilters"` — AND logic (all conditions must match)

**`filters` structure** (when `filterType` is `"manual"`):
```json
"filters": {
  "conditions": [
    {
      "key": "PropertyName|propertyType",
      "condition": "equals",
      "titleValue": "the value to match"
    }
  ]
}
```

**Critical: the value field name depends on the property type** (the part after `|` in the key):
| Property type     | Value field name     |
|-------------------|----------------------|
| `title`           | `titleValue`         |
| `rich_text`       | `richTextValue`      |
| `number`          | `numberValue`        |
| `checkbox`        | `checkboxValue`      |
| `select`          | `selectValue`        |
| `multi_select`    | `multiSelectValue`   |
| `status`          | `statusValue`        |
| `date`            | `date`               |
| `people`          | `peopleValue`        |
| `relation`        | `relationValue`      |
| `email`           | `emailValue`         |
| `url`             | `urlValue`           |
| `phone_number`    | `phoneNumberValue`   |
| `created_by`      | `createdByValue`     |
| `created_time`    | `createdTimeValue`   |
| `last_edited_by`  | `lastEditedByValue`  |
| `last_edited_time`| `lastEditedTime`     |
| `formula`         | requires `returnType` field + type-specific value field |

**Common mistakes:**
- Using `filterType: "formula"` — this is NOT a valid value; `"formula"` is a **property type** used in the `key` field, not a filter type
- Using a generic `value` field — there is no generic `value`; each property type has its own named value field
- Including `returnType` or `combinator` — these are not part of the v2 manual filter structure (except `returnType` is used only when the property type is `formula`)
- Forgetting `matchType` — this is a separate top-level parameter, not nested inside `filters`

**Example — filter where "Identifier" (title) equals an expression:**
```json
{
  "filterType": "manual",
  "matchType": "anyFilter",
  "filters": {
    "conditions": [
      {
        "key": "Identifier|title",
        "condition": "equals",
        "titleValue": "={{ $json.email }}"
      }
    ]
  }
}
```

### Notion node v2.2 simplified output uses `property_` prefixed snake_case field names
The Notion node v2.2 `getAll` operation (on `databasePage`) returns **simplified output** by default. The field names in this output do **not** match the Notion property display names. Instead, they follow this pattern:

- **Title property** → available as both `name` (page title) and `property_<snake_case>` (e.g., `Identifier` → `property_identifier`)
- **All other properties** → `property_` + lowercase + underscores replacing spaces (e.g., `First name` → `property_first_name`, `Company name` → `property_company_name`, `Address Line 2` → `property_address_line_2`)
- **Page metadata** → `id`, `url`, `icon`, `cover`, `name` are top-level (no `property_` prefix)
- **System timestamps** → `created_time` and `last_edited_time` are **NOT** top-level — they appear as `property_created_time` and `property_last_edited_time` (because Notion databases have built-in "Created time" and "Last edited time" property types that the node treats as regular properties). Using `j.created_time` returns `undefined`.

Example: a Notion database with properties "Identifier" (title), "Email" (email), "First name" (rich_text), "Tags" (multi_select) outputs:
```json
{
  "id": "19a8ebaf-15ee-812f-9be8-e3489a526b3b",
  "name": "user@example.com",
  "url": "https://www.notion.so/...",
  "property_identifier": "user@example.com",
  "property_email": "user@example.com",
  "property_first_name": "Jane",
  "property_tags": ["customer", "vip"],
  "property_created_time": "2024-12-29T21:39:00.000Z",
  "property_last_edited_time": "2025-01-15T10:22:00.000Z"
}
```

**This means**: when reading Notion getAll output in a Code node, use the `property_xxx` field names. When *writing* to Notion via `propertiesUi`, continue using the display names with types (e.g., `First name|rich_text`).

### Notion propertiesUi (create/update) uses DIFFERENT value fields from filters (getAll)
The `propertiesUi.propertyValues` entries in the Notion node's **create** and **update** operations use **different parameter names** from the `filters.conditions` entries in **getAll**. Do NOT mix them up.

**Filter (getAll)** value fields (documented above):
- `titleValue`, `richTextValue`, `emailValue`, `phoneNumberValue`, …

**PropertiesUi (create/update)** value fields:
| Property type   | Value field(s)                                                    |
|-----------------|-------------------------------------------------------------------|
| `title`         | `title` (string)                                                  |
| `rich_text`     | `richText` (boolean, default false) + `textContent` (string)      |
| `email`         | `emailValue` (string)                                             |
| `phone_number`  | `phoneValue` (string)                                             |
| `multi_select`  | `multiSelectValue` (comma-separated string or array)              |
| `date`          | `range` (boolean), `includeTime` (boolean), `date` (ISO string), `timezone` (string, default `'default'`) |
| `number`        | `numberValue` (number)                                            |
| `checkbox`      | `checkboxValue` (boolean)                                         |
| `select`        | `selectValue` (string)                                            |
| `url`           | `urlValue` (string)                                               |

**Critical mistakes:**
- Using `richTextValue` in create/update propertiesUi → silently ignored; the correct field is `textContent` with `richText: false`
- Omitting `richText: false` → n8n looks for the complex `text` fixedCollection structure instead of `textContent`
- Omitting `range: false` on date fields → n8n may look for `dateStart`/`dateEnd` instead of `date`

**Example — rich_text property in propertiesUi:**
```json
{ "key": "First name|rich_text", "richText": false, "textContent": "={{ $json[\"First name\"] }}" }
```

### Notion date fields in propertiesUi cannot be null/undefined
When a date property is included in `propertiesUi.propertyValues` (create or update), n8n always evaluates the `date` expression and passes it through `new Date(value)`. If the value is `null` or `undefined`, this produces the string `"Invalid Date"`, which the Notion API rejects with a 400 validation error: `body.properties.Birthday.date.start should be a valid ISO 8601 date string, instead was "Invalid date"`.

There is no way to conditionally skip a field in `propertiesUi` — all listed properties are always sent. **Workaround**: either (a) remove the date field from `propertiesUi` entirely and handle it via a separate conditional path (Filter → dedicated Update node), or (b) don't include the date field if it's not always populated.

### Notion getAll drops items when no match is found
The Notion `getAll` node silently drops input items whose filter returns zero results. The `alwaysOutputData` setting only emits one empty item when the **entire node** produces zero output — it does NOT create a placeholder per dropped input item. This means positional alignment with the original data stream is destroyed when some lookups succeed and some fail.

### Notion node propertiesUi always sends ALL listed properties — use HTTP Request for dynamic bodies
The n8n Notion node's `propertiesUi` sends **every** property listed in `propertyValues`, even when a value resolves to null, empty string, or empty array. The Notion API rejects invalid values (e.g., empty string for `phone_number`, null for `select`), causing 400 validation errors. This applies to both create and update operations.

**Workaround**: Replace the Notion write nodes with **HTTP Request** nodes that call the Notion API directly. Use a Code node upstream to build the request body dynamically, **only including properties that have non-null, non-empty values**.

---

## Notion API (via HTTP Request)

### HTTP Request v4.2 for Notion API calls
Use `authentication: 'predefinedCredentialType'` with `nodeCredentialType: 'notionApi'` to reuse existing Notion credentials. Key parameters:
```json
{
  "method": "PATCH",
  "url": "=https://api.notion.com/v1/pages/{{ $json.pageId }}",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "notionApi",
  "sendHeaders": true,
  "headerParameters": { "parameters": [{ "name": "Notion-Version", "value": "2022-06-28" }] },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ $json.requestBody }}"
}
```
- `typeVersion: 4.2` for the HTTP Request node
- The `Notion-Version` header is **required** — without it, the API returns 400
- For create: `POST https://api.notion.com/v1/pages` with `{ parent: { database_id }, properties }` in the body
- For update: `PATCH https://api.notion.com/v1/pages/{page_id}` with `{ properties }` in the body

### Notion API property format reference
When building Notion API request bodies directly (bypassing the n8n Notion node), use these property formats:
| Type           | Format                                                        |
|----------------|---------------------------------------------------------------|
| `title`        | `{ title: [{ text: { content: "value" } }] }`                |
| `rich_text`    | `{ rich_text: [{ text: { content: "value" } }] }`            |
| `email`        | `{ email: "value" }`                                          |
| `phone_number` | `{ phone_number: "value" }`                                   |
| `select`       | `{ select: { name: "value" } }`                               |
| `multi_select` | `{ multi_select: [{ name: "v1" }, { name: "v2" }] }`         |

To **omit** a property (leave it unchanged on update, or skip it on create), simply don't include it in the `properties` object. This is the key advantage over the Notion node's `propertiesUi`, which always sends everything.

### Notion `status` type property (vs. `select` / `checkbox`)
Notion has a dedicated "Status" property type (distinct from `select` or `checkbox`) with built-in workflow states. In the Notion API, it is written as:
```json
{ "Status": { "status": { "name": "Not started" } } }
```
Common status values (may vary by database): `"Not started"`, `"In progress"`, `"Done"`, `"Archived"`. When filtering via the Notion query API, use `"status": { "equals": "Not started" }` (not `"select"` filter).

### Notion query API filter for `relation` emptiness
To filter database records by whether a relation property is populated or empty:
```json
{ "property": "Sales pipeline", "relation": { "is_not_empty": true } }
{ "property": "Sales pipeline", "relation": { "is_empty": true } }
```
This is different from `select` / `checkbox` filters — use the `"relation"` key with `is_not_empty`/`is_empty`.

### Notion `person` property API format
To set an Assignee (or any person property) via the Notion API:
```json
{ "Assignee": { "people": [{ "id": "user-uuid-here" }] } }
```
The user UUID can be found via `GET https://api.notion.com/v1/users` with the Notion credential.

### Notion POST /pages supports `children` for inline block creation
When creating a new Notion database page via `POST /api.notion.com/v1/pages`, you can include a `children` array to populate the page body in a single API call — no separate PATCH /blocks call needed:
```json
{
  "parent": { "database_id": "..." },
  "properties": { ... },
  "children": [{
    "type": "callout",
    "callout": {
      "icon": { "type": "emoji", "emoji": "..." },
      "rich_text": [{ "type": "text", "text": { "content": "Body content here" } }],
      "color": "yellow_background"
    }
  }]
}
```
This eliminates the fork+merge pattern required when writing to the page body after creation. Only use the separate PATCH when updating an existing page's blocks.

### Raw Notion API vs. Notion node for relation data
The n8n Notion node (v2.2) simplified output returns **empty arrays** for all `relation` type properties. To get actual relation data (the array of linked page IDs), use the raw Notion API via HTTP Request:
- **Query**: `POST /databases/{db_id}/query` — returns full page objects with `properties.RelationName.relation = [{id: "page-uuid"}, ...]`
- **Get page**: `GET /pages/{page_id}` — same full properties structure

Use this pattern when: deduplication depends on relation values, or when downstream logic needs linked page IDs.

### Notion page body (content blocks) via API
Notion pages have both **properties** (structured fields) and a **body** (rich text content blocks). The body is separate from properties and accessed via different API endpoints:

- **Read**: `GET /blocks/{page_id}/children` — returns the block children of the page
- **Append**: `PATCH /blocks/{page_id}/children` — appends new blocks to the page body
- **Auth**: Same Notion credential, requires `Notion-Version: 2022-06-28` header

```json
{
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "type": "text", "text": { "content": "Summary text here" } }]
      }
    }
  ]
}
```

Use this for storing AI-generated summaries, notes, or other free-form content on Notion database pages. Properties handle structured data; the page body handles narrative content.

### Notion relation properties via API
The n8n Notion node's simplified output returns **empty arrays** for relation properties. To read relation data, use the Notion API directly via HTTP Request: `POST /databases/{db_id}/query` (paginated, `page_size: 100`, follow `next_cursor`).

**Reading**: `record.properties['Relation Name'].relation` returns `[{ id: 'page-id-1' }, { id: 'page-id-2' }]`.

**Writing**: To update a relation, PATCH the page with the **complete** relation array (it replaces, not appends):
```json
{ "properties": { "Relation Name": { "relation": [{ "id": "page-id-1" }, { "id": "page-id-2" }] } } }
```

**Dual vs single-property relations**: Notion has two relation types:
- **Dual-property (two-way)**: Both databases have a relation property. Updating one side automatically syncs the other. When merging duplicate contacts, union the page IDs on the contact side — the reverse DB updates itself.
- **Single-property (one-way/inbound)**: Only one database has the relation property. To update these references, you must query the referencing database for records that point to the source contacts and PATCH them directly.

**Targeted relation queries**: Instead of scanning an entire database, use a `relation.contains` filter to find only records referencing specific page IDs:
```json
{
  "filter": {
    "or": [
      { "property": "Master contacts", "relation": { "contains": "source-id-1" } },
      { "property": "Master contacts", "relation": { "contains": "source-id-2" } }
    ]
  },
  "page_size": 100
}
```
This is much more efficient when the set of IDs to search for is small. The Notion API supports up to 100 conditions in a compound filter.

### Notion archive (soft-delete) via API
To archive a Notion page: `PATCH /pages/{page_id}` with `{ "archived": true }` at the **top level** of the body (NOT inside `properties`). This is a soft delete — the page moves to trash and can be restored.

---

## HTTP Request Node

### Switch node v3.2: fallbackOutput placement
- `fallbackOutput` belongs inside `options: { fallbackOutput: 'extra' }`, **not** inside `rules: { ... }`
- Placing it inside `rules` causes "Could not find property option" error on activation
- Valid values: `'none'` (no fallback — unmatched items are dropped) or `'extra'` (adds an extra output for unmatched items)
- `allMatchingOutputs: false` in `options` may also cause issues — omit unless specifically needed
- The working pattern: `rules: { values: [...] }` with `options: { fallbackOutput: 'extra' }` (or `options: {}` to drop unmatched)

### n8n REST API rejects node-level `settings` on PUT/POST
The n8n public API (`PUT /api/v1/workflows/{id}`) rejects node-level `settings` objects (e.g., `{ alwaysOutputData: true }`) as "additional properties". However, it accepts `alwaysOutputData` as a **top-level** node property. The `settings` key appears in GET responses and JSON import format but is not part of the API's write schema.

Accepted top-level workflow fields: `name`, `nodes`, `connections`, `settings` (workflow-level only).

Accepted node-level fields: `id`, `name`, `type`, `typeVersion`, `position`, `parameters`, `credentials`, `disabled`, `onError`, `retryOnFail`, `executeOnce`, `continueOnFail`, `alwaysOutputData`, `notesInFlow`, `notes`, `webhookId`.

Rejected: `active` (use activate/deactivate endpoints), `staticData`, `meta`, `pinData`, `tags`, `versionId`, and node-level `settings`.

### Always verify parameter names against n8n source code
n8n's internal parameter names often differ from what the UI labels suggest. When a node doesn't render correctly after JSON import, check the actual node source on GitHub (`packages/nodes-base/nodes/<NodeName>/`) and test fixtures for the ground truth.

### HTTP Request v4.2 pagination requires double-nested `options.pagination.pagination`
The pagination settings in the HTTP Request node (v4.2) use **double nesting** under `options`. The outer `pagination` key is the option toggle; the inner `pagination` key holds the actual configuration. Using only one level of nesting (`options.pagination.paginationMode`) silently fails — the node imports without errors but pagination doesn't execute, returning only the first page of results.

**Correct structure:**
```json
"options": {
  "pagination": {
    "pagination": {
      "paginationMode": "updateAParameterInEachRequest",
      "parameters": {
        "parameters": [
          { "name": "start_cursor", "type": "body", "value": "={{ $response.body.next_cursor }}" }
        ]
      },
      "paginationCompleteWhen": "other",
      "completeExpression": "={{ !$response.body.has_more }}",
      "limitPagesFetched": true,
      "maxRequests": 100,
      "requestInterval": 350
    }
  }
}
```

Key details:
- `limitPagesFetched: true` enables the `maxRequests` cap
- `requestInterval` is in milliseconds (350ms = ~3 req/s for Notion API compliance)
- `paginationMode` values: `"updateAParameterInEachRequest"` (cursor/offset), `"responseContainsNextURL"` (link-based)
- **Do NOT put query parameters in the URL string** when using `updateAParameterInEachRequest` with `type: 'queryString'`. The pagination engine adds/replaces query string parameters, but if the same parameter (e.g., `offset`) is also hardcoded in the URL string, the URL version takes precedence and pagination never advances (the node detects 5 identical responses and stops). Instead, use `sendQuery: true` with `queryParameters` to set initial values, so the pagination engine can properly replace them.
- **Do NOT duplicate pagination-managed parameters in `queryParameters`**. If the pagination config manages a parameter (e.g., `offset` via `type: 'queryString'`), do NOT also set it in the node's `queryParameters`. The initial request will use `queryParameters`, but subsequent requests may conflict. Only put non-paginated parameters (e.g., `count`) in `queryParameters`; let the pagination config be the sole owner of the paginated parameter.

### Merge v3 `chooseBranch` mode
- Use `useDataOfInput: N` (number, 1-indexed) to select a specific input. The legacy `output: 'inputN'` string format triggers a UI warning ("The value 'inputN' is not supported!").
- **As a join gate** (synchronize branches, don't care about data): omit `useDataOfInput` entirely and set `alwaysOutputData = true` on the node. This ensures at least one item is emitted regardless of which branch produced data, so downstream nodes always execute.

### Merge (combineByPosition) for preserving context through HTTP Request nodes
When an HTTP Request node replaces item data with the API response, use a **fork + Merge** pattern to preserve the original context. Connect the upstream node to BOTH the HTTP Request node AND the Merge node's second input. The Merge (combineByPosition) pairs each HTTP response (input 0) with the original plan item (input 1), combining all fields into one item. This only works reliably when the item count is identical on both inputs (1:1 mapping).

---

## Data Handling Patterns

### Use Set nodes + field-based Merge for reliable multi-item data pairing
When pairing data from two streams (e.g. original incoming data with Notion lookup results), `combineByPosition` breaks if either stream drops or reorders items. The reliable pattern is:

1. **Set nodes** ("Mark Inbound" / "Mark Existing") wrap each stream's data under a unique key (`incoming`, `notion`) and add a shared join field (`Identifier`)
2. **Merge v3** with `fieldsToMatchString` + `joinMode: 'keepEverything'` (outer join) pairs items by the shared field — items without a match still pass through

Merge v3 field-based matching parameters:
```json
{ "mode": "combine", "fieldsToMatchString": "Identifier", "joinMode": "keepEverything", "options": {} }
```
No `combineBy` parameter is needed when using `fieldsToMatchString` — it implicitly selects field-matching mode.

`joinMode` values: `keepMatches` (inner), `keepNonMatches` (anti), `enrichInput1` (left), `enrichInput2` (right), `keepEverything` (outer)

### Set node v3.4 parameter structure
```json
{
  "assignments": {
    "assignments": [
      { "id": "<uuid>", "name": "fieldName", "value": "={{ $json }}", "type": "object" },
      { "id": "<uuid>", "name": "Identifier", "value": "={{ $json.email }}", "type": "string" }
    ]
  },
  "options": {}
}
```

### `$('NodeName').item` vs `.first()` in n8n expressions
In n8n expressions (NOT Code node sandbox), `$('NodeName').item.json.field` correctly references the item from the named node that corresponds to the **current item being processed** — it maintains per-item pairing through the flow. In contrast, `$('NodeName').first().json.field` always retrieves item 0 regardless of which item is being processed. Use `.item` when you need per-item pairing (e.g. in a Set node after a Notion lookup, to get the original email from a previous node).

### Aggregate node for collapsing multiple items into a single item
The `n8n-nodes-base.aggregate` node (v1) with `aggregate: 'aggregateAllItemData'` collapses all input items into a single output item with a named array field. Useful for bringing a full dataset (e.g., all contacts) into a downstream Code node as one item, so it can be merged with other data streams via append.

```json
{
  "aggregate": "aggregateAllItemData",
  "destinationFieldName": "contacts",
  "include": "allFieldsExcept",
  "except": ""
}
```

The output is `{ contacts: [{...}, {...}, ...] }` — one item containing an array of all input items' JSON. Use `include: 'allFieldsExcept'` with empty `except` to include all fields.

### Tagged-append merge pattern for heterogeneous data in Code nodes
When a Code node needs data from multiple sources of different types (e.g., contacts, emails, and existing records), and `$('NodeName')` back-references are unreliable in the Code sandbox, use this pattern:

1. **Aggregate** each homogeneous stream into a single item with a named array field (e.g., `{ contacts: [...] }`, `{ activities: [...] }`)
2. **Tag** individual items with a type identifier (e.g., `{ _type: 'email', _direction: 'received', ... }`)
3. **Merge (append)** all streams together — Aggregate items + tagged items flow into one Code node
4. **Separate by type** in the Code node: iterate `$input.all()`, check for identifying fields (`contacts` array, `activities` array, `_type === 'email'`), and route into separate processing arrays

This avoids `$('NodeName')` back-references entirely — everything arrives via `$input.all()`.

### Sort node (n8n-nodes-base.sort) v1
The Sort node's parameter structure requires a `sortFieldsUi` wrapper around the `sortField` array:

```js
{
  sortFieldsUi: {
    sortField: [
      { fieldName: 'lastModifiedServer', order: 'descending' }
    ],
  },
  options: {},
}
```

**Wrong**: putting `sortField` directly at the top level (e.g., `{ sortField: [...] }`) — this silently produces a node with no sort configured.

---

## Mailchimp Integration

### Mailchimp audience webhooks use form-encoded POST, not JSON
Mailchimp sends audience webhook events as `application/x-www-form-urlencoded` with bracket notation (`data[merges][FNAME]=John`). **n8n does NOT parse bracket notation into nested objects** — the body retains flat keys like `$json.body["data[email]"]` and `$json.body["data[merges][FNAME]"]`. Query parameters are at `$json.query`. Use `body["data[merges][FNAME]"]` bracket access in Code nodes to read fields. ADDRESS sub-fields also stay flat: `data[merges][ADDRESS][addr1]`, `data[merges][ADDRESS][city]`, etc. — not a nested ADDRESS object.

### Mailchimp webhook URL validation requires GET handling
When you add or edit a webhook URL in Mailchimp, it sends a GET request to validate the URL returns HTTP 200. Use a separate GET webhook node on the same path with `responseMode: 'onReceived'` to handle this. The GET and POST webhook nodes need different `webhookId` values but share the same `path`.

### Mailchimp cleaned and upemail events have minimal payloads
The `cleaned` event only reliably includes `data.email` and `data.reason` — no merge fields. The `upemail` event only includes `data.old_email`, `data.new_email`, and `data.new_id`. Don't assume merge fields are present for these event types.

### Mailchimp node error responses with continueRegularOutput
When a Mailchimp node has `onError: 'continueRegularOutput'`, **both** 404 (not found) and 5xx (service unavailable) errors produce output items with `{ "error": "<message>" }` — there is no status code or error type field. You must match on the error message text to distinguish them:

- **Not found (404)**: `{ "error": "The resource you are requesting could not be found" }`
- **Service unavailable (5xx)**: `{ "error": "Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)" }`

Always add a validation node after a Mailchimp lookup with `continueRegularOutput` to check the error message and throw on non-404 errors. Otherwise, API outages silently create duplicate records.

### Mailchimp ADDRESS merge field
Mailchimp's ADDRESS merge field requires a **structured JSON object** with `addr1`, `addr2`, `city`, `state`, `zip`, `country`. Sending a flat string or an object with empty required fields causes a 400 error: "Please enter a complete address".

- Always construct ADDRESS from individual components, not a single string
- Guard ADDRESS before sending: only include it when `addr1` is non-empty
- When `addr1` is empty, send an empty string (not an empty object) to avoid the error

---

## LangChain / AI Nodes

### Basic LLM Chain (`chainLlm` v1.7) parameter structure
Use `promptType: "define"` with `text` containing the prompt (supports expressions like `={{ $json.prompt }}`). Set `hasOutputParser: false` when you don't need structured output parsing (the chain returns raw text in `$json.text`). Include `batching: {}` as an empty object. The node type is `@n8n/n8n-nodes-langchain.chainLlm`.

### Anthropic Chat Model (`lmChatAnthropic`) sub-node wiring
The model node connects to the chain via `ai_languageModel` connection type, not `main`:
```js
connect(modelNode, chainNode, 0, 0, 'ai_languageModel')
```
The `model` parameter is a **plain string** (e.g., `'claude-sonnet-4-6-20250514'`), NOT the resource locator `{ __rl: true, ... }` pattern that `lmChatOpenAi` uses. Using an object causes `"this.model.includes is not a function"` at runtime. Include `options: {}`. Node type: `@n8n/n8n-nodes-langchain.lmChatAnthropic`.

### LLM output pairing with Merge nodes
LLM chain nodes replace the input data with output (the chain's response text). To pair the LLM response with the original input data, use a pattern of: (1) Code node that builds the prompt AND stores original items in `itemsJson`, (2) Chain node processes prompt, (3) Merge (combineByPosition) pairs chain output (input 0) with the Code node's output (input 1), (4) another Code node parses the LLM JSON and merges it back into the original items.

### Model selection for cost optimization
Use cheaper models (Haiku) for classification/scoring tasks where the work is structured evaluation against defined criteria. Use stronger models (Sonnet) for creative writing, voice matching, and nuanced content generation.

### Known issue: n8n Anthropic node 404 errors
The `lmChatAnthropic` node has a known bug (as of n8n ~1.113–1.122) where API calls return 404 "resource not found" even with valid API keys. The same key works via curl. If this occurs, the workaround is to replace the `lmChatAnthropic` + `chainLlm` pair with an HTTP Request node calling `POST https://api.anthropic.com/v1/messages` directly, using `authentication: 'predefinedCredentialType'` with `nodeCredentialType: 'anthropicApi'` and an `anthropic-version: 2023-06-01` header.

---

## File & Binary Handling

### convertToFile v1.1 strips JSON properties
The `convertToFile` node (operation `toText`) strips all original JSON properties from the output item — it returns `json: {}` with only `binary: { data: ... }`. This means downstream expressions like `{{ $json.someField }}` won't work after a `convertToFile` node.

**Workaround**: Use inline expressions that don't depend on JSON from earlier nodes. For example, use `{{ DateTime.now().toFormat("yyyy-MM-dd") }}` instead of `{{ $json.dateStr }}` in the Dropbox upload path.

**Do NOT manually handle binary data in Code nodes** using `Buffer.from(item.binary[key].data, 'base64')`. n8n's internal binary storage may use file-backed storage rather than inline base64, so `.data` is not guaranteed to be a raw base64 string. **To read binary**: use `await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName)` which returns a proper Buffer regardless of storage backend. **To create binary**: use the `convertToFile` node — never construct binary objects manually in Code nodes.

Valid `options` for `toText` operation: `fileName`, `encoding`, `addBOM`. The `mimeType` option does NOT exist — omit it.

### convertToFile operations — use `csv` for CSV output, not `spreadsheet`
The `convertToFile` node (v1.1) has separate operations for different formats. For CSV output, use `operation: 'csv'`. The `spreadsheet` operation is for Excel/ODS formats and requires a `fileFormat` sub-parameter — using `spreadsheet` with `fileFormat: 'csv'` does **not** work (produces no output). Correct:
```json
{ "operation": "csv", "options": { "fileName": "my-file.csv" } }
```

### Dropbox upload node requires `binaryData: true` for binary file uploads
The Dropbox node v1 `upload` operation defaults to text mode, reading from a `fileContent` parameter. To upload binary data from a previous node (e.g., from `convertToFile`), you **must** set `binaryData: true` alongside `binaryPropertyName: 'data'`. Without it, the node ignores the binary property and uploads an empty file.

---

## External API Patterns

### Microsoft Graph API via HTTP Request with Outlook OAuth2 credential
Use `authentication: 'predefinedCredentialType'` with `nodeCredentialType: 'microsoftOutlookOAuth2Api'` to call the Microsoft Graph API from an HTTP Request node, reusing the same Outlook credential used by the Microsoft Outlook node. The credential handles OAuth2 token management automatically.

Key patterns:
- **Base URL**: `https://graph.microsoft.com/v1.0/me/...`
- **Inbox**: `GET /me/mailFolders/inbox/messages`
- **Sent**: `GET /me/mailFolders/sentItems/messages`
- **OData query params**: Use `$filter`, `$select`, `$top`, `$orderby` as query string parameters
- **Date filtering**: `receivedDateTime ge '2024-01-15T00:00:00Z'` or `sentDateTime ge '...'`
- **Scope requirement**: The OAuth2 credential must include `Mail.Read` scope for reading emails (in addition to `Mail.Send` for sending via the Outlook node)

```json
{
  "method": "GET",
  "url": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "microsoftOutlookOAuth2Api",
  "sendQuery": true,
  "queryParameters": {
    "parameters": [
      { "name": "$filter", "value": "=receivedDateTime ge '{{ ... }}'" },
      { "name": "$select", "value": "id,subject,from,toRecipients,receivedDateTime,body" },
      { "name": "$top", "value": "100" }
    ]
  }
}
```

### Reddit API requires OAuth — use oauth.reddit.com
Reddit's public `.json` endpoints (`www.reddit.com/r/.../top.json`) return 403 for unauthenticated requests. Authenticated requests must use `oauth.reddit.com` as the host (not `www.reddit.com`). In n8n, attach the `redditOAuth2Api` credential to an HTTP Request node via `authentication: 'predefinedCredentialType'` + `nodeCredentialType: 'redditOAuth2Api'`. When a workflow fetches from multiple APIs (some needing auth, some not), split the fetch into separate HTTP Request nodes using an IF node on `sourceType`, then recombine results with a Merge (append) before normalizing.

### Webflow field slugs can differ from what you expect
When creating a new Webflow CMS field, the auto-generated slug may have a numeric suffix if a similar slug already exists. For example, creating a field named "Endorsement Body" when a field with slug `endorsement-body` (or close variant) is already in the collection results in a slug of `endorsement-body-2`. Always verify the actual slug in Webflow Designer (field settings panel) before referencing it in n8n workflows. The Webflow API returns `"Field not described in schema: undefined"` (400) when a field slug is not found — this is the diagnostic for a wrong slug.

### Plain text vs Rich Text elements in Webflow
Webflow CMS rich text fields must be bound to a **Rich Text element** (a div-based block), not a plain Text Block. If an existing page uses a Text Block bound to the old plain text field, replace it with a Rich Text element and re-bind to the new rich text field. Style the nested elements (p, strong, em, a, etc.) using the nested elements section of the Rich Text element's style panel.
