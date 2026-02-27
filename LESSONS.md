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

### Always verify parameter names against n8n source code
n8n's internal parameter names often differ from what the UI labels suggest. When a node doesn't render correctly after JSON import, check the actual node source on GitHub (`packages/nodes-base/nodes/<NodeName>/`) and test fixtures for the ground truth.
