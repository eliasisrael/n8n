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
- `runOnceForAllItems` processes all items in a single execution — this breaks item-level linkage to downstream nodes
- `runOnceForEachItem` processes each item individually, preserving per-item context
- In `runOnceForEachItem` mode, use `$json` for the current item (not `$input.first().json`) and return a single `{ json: ... }` object (not a wrapped array)

## General Patterns

### Use Filter nodes instead of IF nodes for simple validation gates
When you only need to drop records that fail a check (no logic needed on the failing branch), use a Filter node. An IF node with an empty false branch is wasteful.

### Always verify parameter names against n8n source code
n8n's internal parameter names often differ from what the UI labels suggest. When a node doesn't render correctly after JSON import, check the actual node source on GitHub (`packages/nodes-base/nodes/<NodeName>/`) and test fixtures for the ground truth.
