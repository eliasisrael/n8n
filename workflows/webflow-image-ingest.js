/**
 * Webflow Image Ingest — Sub-workflow (Path B)
 *
 * Turns an ephemeral Notion signed-S3 image URL into a permanent, valid,
 * Webflow-hosted asset URL, by uploading the actual bytes to Webflow's Assets
 * API instead of handing Webflow a fragile proxy URL to re-host.
 *
 * Why: Notion image URLs are presigned for GET only (HEAD 403s) and expire
 * hourly, and the Cloudinary *fetch* proxy can't retrieve them — so Webflow
 * was re-hosting a 0-byte error GIF. Uploading the bytes ourselves removes
 * every one of those failure modes.
 *
 * Flow: Download (stream → filesystem binary) → Resize if oversized (Edit Image,
 * needs ImageMagick/GraphicsMagick on host) → Prep (md5 + filename) →
 * Create Webflow Asset (presigned S3 POST details) → Upload bytes to S3 →
 * return { hostedUrl }.
 *
 * Input:  { imageUrl }         (via Execute Workflow, or webhook body for testing)
 * Output: { hostedUrl, assetId, fileName }
 *
 * NOTE: The Edit Image (resize) node requires ImageMagick or GraphicsMagick in
 * the n8n container. If absent, enable it (env/install) and restart. Small
 * images pass through untouched (resize is only-if-larger).
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const WEBFLOW_SITE_ID = '66022db75af9853636d1ce23';

// Assets API needs the 'assets:write' scope, which the OAuth2 credential lacks.
// This is a Webflow API-token credential scoped for assets (its save-time test
// in n8n fails on an unrelated endpoint — that's a false negative, the token is
// valid for /assets as confirmed by a direct curl).
const WEBFLOW_ASSETS_CREDENTIAL = {
  webflowApi: { id: 'Bgw7jgcnYyoyObRx', name: 'VennFactory Webflow Assets Access' },
};

// ---------------------------------------------------------------------------
// Code: compute md5 (Webflow fileHash) + derive a safe filename/content-type
// ---------------------------------------------------------------------------
const PREP_ASSET_CODE = `
const crypto = require('crypto');
const items = $input.all();
const out = [];
for (let i = 0; i < items.length; i++) {
  const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const j = items[i].json || {};
  const bin = (items[i].binary && items[i].binary.data) ? items[i].binary.data : {};

  let name = String(j.imageUrl || '').split('?')[0].split('/').pop() || ('image-' + md5.slice(0, 10));
  try { name = decodeURIComponent(name); } catch (e) {}
  name = name.replace(/[^A-Za-z0-9._-]/g, '_');

  let contentType = bin.mimeType || 'image/jpeg';
  if (!/\\.[A-Za-z0-9]+$/.test(name)) {
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    name = name + '.' + ext;
  }

  out.push({ json: { fileName: name, fileHash: md5, contentType, imageUrl: j.imageUrl }, binary: items[i].binary });
}
return out;
`.trim();

// ---------------------------------------------------------------------------
// Code: emit { hostedUrl } per image, position-matched to Merge Asset + Binary.
// The actual S3 upload is now a dedicated HTTP Request node ("Upload to S3")
// that streams the binary from the store. The old Code-node upload built the
// whole multipart body in memory and POSTed it via this.helpers.httpRequest —
// under n8n's task-runner architecture that transfers the multi-MB body across
// the runner IPC boundary, which hung to the 300s task timeout. Keeping this
// step as a Code node is fine: it touches no binary and returns instantly.
// ---------------------------------------------------------------------------
const EMIT_HOSTED_CODE = `
const merged = $('Merge Asset + Binary').all();
return merged.map(m => ({ json: { hostedUrl: m.json.hostedUrl, assetId: m.json.id, fileName: m.json.fileName } }));
`.trim();

// ---------------------------------------------------------------------------
// Code: normalize input to N items each { imageUrl }. Accepts:
//   - Execute Workflow: N items each { imageUrl }  (multi-image caller)
//   - Webhook body { imageUrl }  or  { images: [{ imageUrl }, ...] }  (testing)
// Output order is preserved end-to-end, so the caller maps hosted URLs by
// position. A single image with no key still returns one { hostedUrl } item
// (backward-compatible with the appearances integration).
// ---------------------------------------------------------------------------
const NORMALIZE_INPUT_CODE = `
const items = $input.all();
const out = [];
for (const it of items) {
  const j = it.json || {};
  const body = j.body || j;
  if (Array.isArray(body.images)) {
    for (const im of body.images) { if (im && im.imageUrl) out.push({ json: { imageUrl: im.imageUrl } }); }
  } else if (body.imageUrl) {
    out.push({ json: { imageUrl: body.imageUrl } });
  } else if (j.imageUrl) {
    out.push({ json: { imageUrl: j.imageUrl } });
  }
}
return out;
`.trim();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const execTrigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  { inputSource: 'passthrough' },
  { position: [-400, 0], typeVersion: 1.1 },
);

// Webhook trigger for standalone testing: POST { imageUrl } → returns hostedUrl.
const webhookTrigger = createNode(
  'Test via Webhook',
  'n8n-nodes-base.webhook',
  { httpMethod: 'POST', path: 'webflow-image-ingest-test', responseMode: 'lastNode', options: {} },
  { position: [-400, 200], typeVersion: 2 },
);
webhookTrigger.webhookId = 'webflow-image-ingest-test';

// Normalize both trigger shapes into N items each { imageUrl }.
const normalize = createNode(
  'Normalize Input',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: NORMALIZE_INPUT_CODE },
  { position: [-180, 100], typeVersion: 2 },
);

// Download the image bytes to a filesystem-backed binary property.
const download = createNode(
  'Download Image',
  'n8n-nodes-base.httpRequest',
  {
    method: 'GET',
    url: '={{ $json.imageUrl }}',
    options: {
      timeout: 20000,
      redirect: { redirect: { followRedirects: true } },
      response: { response: { responseFormat: 'file', outputPropertyName: 'data' } },
    },
  },
  { position: [40, 100], typeVersion: 4.2 },
);
download.retryOnFail = true;
download.maxTries = 3;
download.waitBetweenTries = 1000;

// Resize only if larger than 1600px on a side — bounds oversized images under
// Webflow's 4MB cap; small images pass through unchanged. Needs ImageMagick/GM.
const resize = createNode(
  'Resize If Oversized',
  'n8n-nodes-base.editImage',
  {
    operation: 'resize',
    dataPropertyName: 'data',
    width: 1600,
    height: 1600,
    options: { resizeOption: 'onlyIfLarger' },
  },
  { position: [40, 100], typeVersion: 1 },
);
resize.onError = 'continueRegularOutput';  // if resize unavailable, upload original

const prepAsset = createNode(
  'Prep Asset',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: PREP_ASSET_CODE },
  { position: [260, 100], typeVersion: 2 },
);

const createAsset = createNode(
  'Create Webflow Asset',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/assets`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'webflowApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'accept', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ fileName: $json.fileName, fileHash: $json.fileHash }) }}',
    options: {},
  },
  { position: [480, 40], typeVersion: 4.2, credentials: WEBFLOW_ASSETS_CREDENTIAL },
);
createAsset.retryOnFail = true;

// Re-join the Webflow asset response (uploadUrl/uploadDetails/hostedUrl) with
// the binary that Prep Asset still carries (the HTTP node drops binary).
const mergeAsset = createNode(
  'Merge Asset + Binary',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [700, 100], typeVersion: 3 },
);

// Stream the bytes to the Webflow-provided presigned S3 endpoint via a real
// HTTP Request node (runs in the main process, streams the binary from the
// store — no multi-MB body across the task-runner IPC boundary). The presigned
// POST fields are a fixed set from Webflow; the file part MUST be last.
const uploadS3 = createNode(
  'Upload to S3',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: '={{ $json.uploadUrl }}',
    sendBody: true,
    contentType: 'multipart-form-data',
    bodyParameters: {
      parameters: [
        { name: 'acl', value: '={{ $json.uploadDetails.acl }}' },
        { name: 'bucket', value: '={{ $json.uploadDetails.bucket }}' },
        { name: 'X-Amz-Algorithm', value: '={{ $json.uploadDetails["X-Amz-Algorithm"] }}' },
        { name: 'X-Amz-Credential', value: '={{ $json.uploadDetails["X-Amz-Credential"] }}' },
        { name: 'X-Amz-Date', value: '={{ $json.uploadDetails["X-Amz-Date"] }}' },
        { name: 'key', value: '={{ $json.uploadDetails.key }}' },
        { name: 'Policy', value: '={{ $json.uploadDetails.Policy }}' },
        { name: 'X-Amz-Signature', value: '={{ $json.uploadDetails["X-Amz-Signature"] }}' },
        { name: 'success_action_status', value: '={{ $json.uploadDetails.success_action_status }}' },
        { name: 'content-type', value: '={{ $json.uploadDetails["content-type"] }}' },
        { name: 'Cache-Control', value: '={{ $json.uploadDetails["Cache-Control"] }}' },
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      ],
    },
    options: { timeout: 60000 },
  },
  { position: [920, 100], typeVersion: 4.2 },
);
uploadS3.retryOnFail = true;
uploadS3.maxTries = 3;
uploadS3.waitBetweenTries = 3000;

const emitHosted = createNode(
  'Emit Hosted URL',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: EMIT_HOSTED_CODE },
  { position: [1140, 100], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Webflow Image Ingest', {
  nodes: [
    execTrigger,
    webhookTrigger,
    normalize,
    download,
    resize,
    prepAsset,
    createAsset,
    mergeAsset,
    uploadS3,
    emitHosted,
  ],
  connections: [
    connect(execTrigger, normalize),
    connect(webhookTrigger, normalize),
    connect(normalize, download),
    connect(download, resize),
    connect(resize, prepAsset),
    // fork: Create Asset (HTTP, loses binary) + passthrough (keeps binary) → merge
    connect(prepAsset, createAsset),
    connect(createAsset, mergeAsset, 0, 0),
    connect(prepAsset, mergeAsset, 0, 1),
    connect(mergeAsset, uploadS3),
    connect(uploadS3, emitHosted),
  ],
  settings: {
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
});
