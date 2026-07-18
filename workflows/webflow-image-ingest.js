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
 * Flow: Download (stream → filesystem binary) → Is Vector? ─ SVG bypasses the
 * resize; raster goes through Resize if oversized (Edit Image, needs
 * ImageMagick/GraphicsMagick on host) ─ → Merge → Sort by Index (restores the
 * caller's order, which the branch/rejoin would otherwise scramble) →
 * Prep (md5 + filename) → Create Webflow Asset (presigned S3 POST details) →
 * Upload bytes to S3 → return { hostedUrl }.
 *
 * Input:  { imageUrl }         (via Execute Workflow)
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

// Webflow infers an asset's type from the filename extension, so the extension
// MUST match the bytes. Never derive it by splitting the MIME subtype: that
// yields '.svg+xml' for image/svg+xml and '.octet-stream' for a generic
// download, both of which Webflow cannot serve.
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff', 'image/bmp': 'bmp',
};
const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  tiff: 'image/tiff', tif: 'image/tiff', bmp: 'image/bmp',
};
const isGeneric = (t) => !t || t === 'application/octet-stream' || t === 'binary/octet-stream';

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

  let contentType = String(bin.mimeType || '').toLowerCase();

  // Trust an extension already on the URL-derived name; otherwise map from the
  // MIME type, then fall back to what n8n sniffed, then to jpg.
  let ext = (name.match(/\\.([A-Za-z0-9]+)$/) || [])[1];
  if (ext) {
    ext = ext.toLowerCase();
  } else {
    ext = MIME_TO_EXT[contentType] || String(bin.fileExtension || '').toLowerCase() || 'jpg';
    name = name + '.' + ext;
  }

  // A generic/missing content type is more trustworthy when re-derived from the
  // (now known-good) extension.
  if (isGeneric(contentType)) contentType = EXT_TO_MIME[ext] || 'application/octet-stream';

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
// Code: normalize input to N items each { imageUrl, _idx }. Accepts:
//   - Execute Workflow: N items each { imageUrl }  (multi-image caller)
//   - a { images: [{ imageUrl }, ...] } body shape
// Output order is preserved end-to-end, so the caller maps hosted URLs by
// position. A single image with no key still returns one { hostedUrl } item
// (backward-compatible with the appearances integration).
//
// `_idx` records the original input order. The SVG bypass below splits the
// stream in two and rejoins it, which would otherwise reorder items in a mixed
// batch (e.g. a testimonial with one PNG and one SVG) — and callers map hosted
// URLs back to fields BY POSITION. "Sort by Index" restores it before Prep Asset.
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
return out.map((o, i) => ({ json: { ...o.json, _idx: i } }));
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

// NOTE: a 'Test via Webhook' trigger used to live here for standalone testing.
// Removed as unnecessary — the sub-workflow is reached via Execute Workflow, and
// a stray public webhook on a sub-workflow is needless surface area.
//
// IMPORTANT (n8n 2.x): this workflow MUST stay *published*. Production callers
// resolve a sub-workflow to its published version and throw "Workflow is not
// active and cannot be executed" when there is none — which is what actually
// broke every caller in July 2026. Pushing via the public API only writes a
// draft unless the workflow is already published, so after deploying changes
// here verify activeVersionId === versionId. See GENERAL-LESSONS.md.
//
// Also note: manual/editor runs use the DRAFT, production uses the PUBLISHED
// version — so this can test green in the UI while every caller fails.

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

// Vector images (SVG) must NOT go through Edit Image. GraphicsMagick either
// can't read SVG at all, or rasterises it to a bitmap while n8n keeps the
// original binary metadata — so we'd upload raster bytes still named .svg and
// typed image/svg+xml, and Webflow would serve an unrenderable asset. There is
// also nothing to bound: an SVG is vector and tiny. Webflow accepts SVG in this
// field, so the bypass uploads the original bytes untouched.
const isVector = createNode(
  'Is Vector (SVG)?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'a1e4c0d2-6b7f-4c1a-9d3e-5f8a2b6c7d10',
          // Optional-chain $binary itself: if it is undefined in this context the
          // expression would throw rather than fall through to the URL check.
          leftValue: "={{ ($binary?.data?.mimeType || '').toLowerCase().includes('svg') || ($json.imageUrl || '').split('?')[0].toLowerCase().endsWith('.svg') }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [260, 100], typeVersion: 2.2 },
);

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
  { position: [480, 200], typeVersion: 1 },
);
resize.onError = 'continueRegularOutput';  // if resize unavailable, upload original

// Rejoin the vector-bypass and raster branches, then restore the caller's
// original ordering (append puts all of one branch before the other).
const mergeBranches = createNode(
  'Merge Vector + Raster',
  'n8n-nodes-base.merge',
  { mode: 'append', options: {} },
  { position: [700, 100], typeVersion: 3 },
);

const sortByIndex = createNode(
  'Sort by Index',
  'n8n-nodes-base.sort',
  {
    type: 'simple',
    sortFieldsUi: { sortField: [{ fieldName: '_idx', order: 'ascending' }] },
    options: {},
  },
  { position: [920, 100], typeVersion: 1 },
);

const prepAsset = createNode(
  'Prep Asset',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: PREP_ASSET_CODE },
  { position: [1140, 100], typeVersion: 2 },
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
  { position: [1360, 20], typeVersion: 4.2, credentials: WEBFLOW_ASSETS_CREDENTIAL },
);
createAsset.retryOnFail = true;

// Re-join the Webflow asset response (uploadUrl/uploadDetails/hostedUrl) with
// the binary that Prep Asset still carries (the HTTP node drops binary).
const mergeAsset = createNode(
  'Merge Asset + Binary',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [1580, 100], typeVersion: 3 },
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
  { position: [1800, 100], typeVersion: 4.2 },
);
uploadS3.retryOnFail = true;
uploadS3.maxTries = 3;
uploadS3.waitBetweenTries = 3000;

const emitHosted = createNode(
  'Emit Hosted URL',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: EMIT_HOSTED_CODE },
  { position: [2020, 100], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Webflow Image Ingest', {
  nodes: [
    execTrigger,
    normalize,
    download,
    isVector,
    resize,
    mergeBranches,
    sortByIndex,
    prepAsset,
    createAsset,
    mergeAsset,
    uploadS3,
    emitHosted,
  ],
  connections: [
    connect(execTrigger, normalize),
    connect(normalize, download),
    // SVG bypasses Edit Image entirely; raster goes through the resize.
    connect(download, isVector),
    connect(isVector, mergeBranches, 0, 0),   // true  → vector, skip resize
    connect(isVector, resize, 1),             // false → raster, resize if oversized
    connect(resize, mergeBranches, 0, 1),
    connect(mergeBranches, sortByIndex),      // restore caller's original order
    connect(sortByIndex, prepAsset),
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
