/**
 * Helpers for building n8n workflow JSON programmatically.
 *
 * Usage:
 *   import { createWorkflow, createNode, connect } from '../lib/workflow.js';
 *
 *   const trigger = createNode('Schedule Trigger', 'n8n-nodes-base.scheduleTrigger', {
 *     rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
 *   });
 *
 *   const http = createNode('HTTP Request', 'n8n-nodes-base.httpRequest', {
 *     url: 'https://api.example.com/data',
 *     method: 'GET',
 *   });
 *
 *   export default createWorkflow('My Workflow', {
 *     nodes: [trigger, http],
 *     connections: [connect(trigger, http)],
 *   });
 */

let _posX = 250;
let _posY = 300;

function resetPositions() {
  _posX = 250;
  _posY = 300;
}

/**
 * Create an n8n node definition.
 *
 * @param {string} name          - Display name in the n8n canvas
 * @param {string} type          - n8n node type identifier (e.g. 'n8n-nodes-base.httpRequest')
 * @param {object} parameters    - Node-specific parameters
 * @param {object} [opts]        - Optional overrides (position, typeVersion, etc.)
 * @returns {object} Node definition object
 */
export function createNode(name, type, parameters = {}, opts = {}) {
  const node = {
    id: opts.id || crypto.randomUUID(),
    name,
    type,
    typeVersion: opts.typeVersion ?? 1,
    position: opts.position || [_posX, _posY],
    parameters,
  };

  // Auto-advance position for the next node so they don't stack
  _posX += 250;

  if (opts.credentials) {
    node.credentials = opts.credentials;
  }

  if (opts.disabled) {
    node.disabled = true;
  }

  return node;
}

/**
 * Create a connection between two nodes.
 *
 * @param {object} from            - Source node object
 * @param {object} to              - Target node object
 * @param {number} [fromOutput=0]  - Source output index
 * @param {number} [toInput=0]     - Target input index
 * @param {string} [fromType='main'] - Connection type
 * @returns {{ from: object, to: object }} Connection descriptor
 */
export function connect(from, to, fromOutput = 0, toInput = 0, fromType = 'main') {
  return { from, to, fromOutput, toInput, fromType };
}

/**
 * Assemble a complete n8n workflow JSON object.
 *
 * @param {string} name          - Workflow name
 * @param {object} opts
 * @param {object[]} opts.nodes        - Array of node objects from createNode()
 * @param {object[]} opts.connections   - Array of connection objects from connect()
 * @param {boolean}  [opts.active=false] - Whether the workflow starts active
 * @param {object}   [opts.settings={}]  - Workflow-level settings
 * @param {string[]} [opts.tags=[]]      - Tags for the workflow
 * @returns {object} Complete n8n workflow JSON
 */
export function createWorkflow(name, { nodes = [], connections = [], active = false, settings = {}, tags = [] } = {}) {
  resetPositions();

  // Build the connections object in n8n's format:
  // { "NodeName": { "main": [[{ "node": "OtherNode", "type": "main", "index": 0 }]] } }
  const conns = {};
  for (const c of connections) {
    const fromName = c.from.name;
    if (!conns[fromName]) {
      conns[fromName] = {};
    }
    if (!conns[fromName][c.fromType]) {
      conns[fromName][c.fromType] = [];
    }
    // Ensure the output index array exists
    while (conns[fromName][c.fromType].length <= c.fromOutput) {
      conns[fromName][c.fromType].push([]);
    }
    conns[fromName][c.fromType][c.fromOutput].push({
      node: c.to.name,
      type: c.fromType,
      index: c.toInput,
    });
  }

  // Convert plain-string tags to the object format n8n expects
  const tagObjects = tags.map((t) =>
    typeof t === 'string' ? { name: t } : t,
  );

  return {
    name,
    nodes,
    connections: conns,
    active,
    settings: {
      executionOrder: 'v1',
      ...settings,
    },
    staticData: null,
    pinData: {},
    tags: tagObjects,
    meta: {
      templateCredsSetupCompleted: true,
    },
  };
}
