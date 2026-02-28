# Lessons Learned

Hard-won knowledge from building and importing n8n workflows. Always check this file when designing solutions.

---

## n8n JSON Import Compatibility

### Workflow envelope must include extra fields
The workflow JSON must include `staticData: null`, `pinData: {}`, `meta: { templateCredsSetupCompleted: true }`, and tags as `{ name: "..." }` objects (not plain strings). Without these, n8n may reject the file or behave unexpectedly on import.

### Execute Sub-workflow Trigger (v1.1) parameter names
- The input mode selector is **`inputSource`** (not `inputDataMode`)
- Valid values: `"jsonExample"`, `"workflowInputs"`, `"passthrough"`
- The JSON content field is **`jsonExample`** (a string containing JSON)
- `typeVersion` must be `1.1` for input modes to work at all
- The `defineBelow` / `workflowInputs` mode has a known bug where fields don't render on JSON import; use `jsonExample` mode instead

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

### Code node execution mode matters
- `runOnceForAllItems` processes all items in one execution; use `$('Node').first().json` and `$input.first().json`; return an array `[{ json: ... }]`
- `runOnceForEachItem` processes each item individually; use `$json` for the current item and `$('Node').item.json` for paired items; return a single `{ json: ... }` object
- **Item pairing breaks across data-replacing nodes**: In `runOnceForEachItem` mode, `$('Node').item` pairs items by index. If an intermediate node (like a Notion lookup) replaces the data entirely, the pairing between the original trigger output and the current item breaks — `$('Node').item.json` will return empty/null data
- **`$('NodeName')` back-references are unreliable in the Code node sandbox**: The Code node's JavaScript sandbox may not support `$('NodeName').all()` or `$('NodeName').first()` the same way n8n's expression engine does. Calling `$('Receive Contact').first()` produced `"Property first does not exist on type"`, and `$('Receive Contact').all()` silently returned empty data. **Workaround**: use an n8n **Merge node** (v3, `combineByPosition`) to pair the original data with the downstream data before the Code node, so `$input.all()` contains everything the Code node needs — no back-references required
- **When item pairing breaks, use a Merge node**: Instead of trying to reconstruct the pairing with `$('Trigger Node').all()` in a Code node (which may fail silently), use an n8n Merge node to explicitly combine the two data streams. Wire the original data (e.g., from a Filter node) into the Merge node's second input alongside the transformed data (e.g., from an IF TRUE branch) on the first input

## General Patterns

### Use Filter nodes instead of IF nodes for simple validation gates
When you only need to drop records that fail a check (no logic needed on the failing branch), use a Filter node. An IF node with an empty false branch is wasteful.

### Use IF nodes to skip expensive operations when the pipeline is empty
When a workflow branch may produce zero items (e.g., all items filtered out), use an IF node to check for a sentinel value (like `_empty: true`) and bypass expensive operations (API calls, LLM invocations) on the false branch. This is cheaper and faster than sending dummy requests to external APIs. Pattern: Code node returns `{ _empty: true }` when empty → IF node checks `_empty notEquals true` → true branch proceeds normally, false branch skips directly to the next convergence point.

### Notion node `databaseId` and `pageId` use the resource locator pattern
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
- **Page metadata** → `id`, `url`, `icon`, `cover`, `created_time`, `last_edited_time`

Example: a Notion database with properties "Identifier" (title), "Email" (email), "First name" (rich_text), "Tags" (multi_select) outputs:
```json
{
  "id": "19a8ebaf-15ee-812f-9be8-e3489a526b3b",
  "name": "user@example.com",
  "property_identifier": "user@example.com",
  "property_email": "user@example.com",
  "property_first_name": "Jane",
  "property_tags": ["customer", "vip"]
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
In n8n expressions (NOT Code node sandbox), `$('NodeName').item.json.field` correctly references the item from the named node that corresponds to the **current item being processed** — it maintains per-item pairing through the flow. In contrast, `$('NodeName').first().json.field` always retrieves item 0 regardless of which item is being processed. Use `.item` when you need per-item pairing (e.g. in a Set node after a Notion lookup, to get the original email from Has Email?).

### Notion node propertiesUi always sends ALL listed properties — use HTTP Request for dynamic bodies
The n8n Notion node's `propertiesUi` sends **every** property listed in `propertyValues`, even when a value resolves to null, empty string, or empty array. The Notion API rejects invalid values (e.g., empty string for `phone_number`, null for `select`), causing 400 validation errors. This applies to both create and update operations.

**Workaround**: Replace the Notion write nodes with **HTTP Request** nodes that call the Notion API directly. Use a Code node upstream to build the request body dynamically, **only including properties that have non-null, non-empty values**.

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

### n8n REST API rejects node-level `settings` on PUT/POST
The n8n public API (`PUT /api/v1/workflows/{id}`) rejects node-level `settings` objects (e.g., `{ alwaysOutputData: true }`) as "additional properties". However, it accepts `alwaysOutputData` as a **top-level** node property. The `settings` key appears in GET responses and JSON import format but is not part of the API's write schema.

Accepted top-level workflow fields: `name`, `nodes`, `connections`, `settings` (workflow-level only).

Accepted node-level fields: `id`, `name`, `type`, `typeVersion`, `position`, `parameters`, `credentials`, `disabled`, `onError`, `retryOnFail`, `executeOnce`, `continueOnFail`, `alwaysOutputData`, `notesInFlow`, `notes`, `webhookId`.

Rejected: `active` (use activate/deactivate endpoints), `staticData`, `meta`, `pinData`, `tags`, `versionId`, and node-level `settings`.

### Always ask permission before pushing workflows to the server
Never run `push-workflows.js` (or otherwise upload a workflow to the n8n server) without explicit user confirmation first. Building to `output/` is safe, but pushing to the live server can overwrite running workflows and should always be a deliberate, user-approved action.

### Always verify parameter names against n8n source code
n8n's internal parameter names often differ from what the UI labels suggest. When a node doesn't render correctly after JSON import, check the actual node source on GitHub (`packages/nodes-base/nodes/<NodeName>/`) and test fixtures for the ground truth.

### Mailchimp audience webhooks use form-encoded POST, not JSON
Mailchimp sends audience webhook events as `application/x-www-form-urlencoded` with bracket notation (`data[merges][FNAME]=John`). **n8n does NOT parse bracket notation into nested objects** — the body retains flat keys like `$json.body["data[email]"]` and `$json.body["data[merges][FNAME]"]`. Query parameters are at `$json.query`. Use `body["data[merges][FNAME]"]` bracket access in Code nodes to read fields. ADDRESS sub-fields also stay flat: `data[merges][ADDRESS][addr1]`, `data[merges][ADDRESS][city]`, etc. — not a nested ADDRESS object.

### Mailchimp webhook URL validation requires GET handling
When you add or edit a webhook URL in Mailchimp, it sends a GET request to validate the URL returns HTTP 200. Use a separate GET webhook node on the same path with `responseMode: 'onReceived'` to handle this. The GET and POST webhook nodes need different `webhookId` values but share the same `path`.

### Mailchimp cleaned and upemail events have minimal payloads
The `cleaned` event only reliably includes `data.email` and `data.reason` — no merge fields. The `upemail` event only includes `data.old_email`, `data.new_email`, and `data.new_id`. Don't assume merge fields are present for these event types.

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

### Model selection for cost optimization
Use cheaper models (Haiku 4.5) for classification/scoring tasks where the work is structured evaluation against defined criteria. Use stronger models (Sonnet 4.6) for creative writing, voice matching, and nuanced content generation.

**Current model IDs** (from Anthropic docs, Feb 2026):
| Model | API ID | Alias |
|-------|--------|-------|
| Sonnet 4.6 | `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` |
| Opus 4.6 | `claude-opus-4-6` | `claude-opus-4-6` |
| Sonnet 4.5 | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` |

Use the alias (no date suffix) for latest models; use dated IDs to pin a specific snapshot. **Note**: Claude 3.x models (e.g., `claude-3-5-haiku-20241022`) have been deprecated and return 404 "model not found" errors.

### Dropbox upload node requires `binaryData: true` for binary file uploads
The Dropbox node v1 `upload` operation defaults to text mode, reading from a `fileContent` parameter. To upload binary data from a previous node (e.g., from `convertToFile`), you **must** set `binaryData: true` alongside `binaryPropertyName: 'data'`. Without it, the node ignores the binary property and uploads an empty file.

### Reddit API requires OAuth — use oauth.reddit.com
Reddit's public `.json` endpoints (`www.reddit.com/r/.../top.json`) return 403 for unauthenticated requests. Authenticated requests must use `oauth.reddit.com` as the host (not `www.reddit.com`). In n8n, attach the `redditOAuth2Api` credential to an HTTP Request node via `authentication: 'predefinedCredentialType'` + `nodeCredentialType: 'redditOAuth2Api'`. When a workflow fetches from multiple APIs (some needing auth, some not), split the fetch into separate HTTP Request nodes using an IF node on `sourceType`, then recombine results with a Merge (append) before normalizing.

### Known issue: n8n Anthropic node 404 errors
The `lmChatAnthropic` node has a known bug (as of n8n ~1.113–1.122) where API calls return 404 "resource not found" even with valid API keys. The same key works via curl. If this occurs, the workaround is to replace the `lmChatAnthropic` + `chainLlm` pair with an HTTP Request node calling `POST https://api.anthropic.com/v1/messages` directly, using `authentication: 'predefinedCredentialType'` with `nodeCredentialType: 'anthropicApi'` and an `anthropic-version: 2023-06-01` header.
