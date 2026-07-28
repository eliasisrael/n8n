/**
 * Ingest NDA Contracts — Dropbox → Notion
 *
 * Watches each client's Contracts folder in the Venn Factory account tree,
 * extracts the key terms from any new executed NDA, and creates a record in
 * the Notion NDAs database.
 *
 * Dropbox layout:
 *   /Filing Cabinet/*Venn Factory/VF accts/<account name>/Contracts/   ← EXECUTED (processed)
 *   /Filing Cabinet/*Venn Factory/VF accts/<account name>/Contracts/<sub>/  ← drafts (ignored)
 *
 * Only files sitting DIRECTLY in `Contracts` are treated as executed. Drafts
 * live in subfolders, and we never descend: the Dropbox folder list is
 * non-recursive, and "Filter: PDFs Only" additionally drops folder entries.
 * The `*` in `*Venn Factory` is a literal character, not a glob; `VF accts` has none.
 *
 * The account folder name gives us the client, so the counterparty does not
 * have to be guessed from the document. The model still supplies the formal
 * legal entity (the signature block often differs from the folder name).
 *
 * LIVE since 2026-07-18. `Config.dryRun` is the kill switch: set it to true to
 * report what WOULD be created and write nothing. Verified across four dry runs
 * before going live.
 *
 * Known, accepted imprecision: `Expired?` is computed from an explicit
 * term_end_date, which only ~3 in 19 agreements state — event-based terms
 * therefore read "No" and need a hand-flip once the event has passed. And the
 * confidentiality_found gate is a judgement call, so a borderline document can
 * take an extra run to land (self-healing: once recorded, dedup keeps it).
 *
 * Dedup: the Dropbox web link is stored in the NDAs `NDA file` URL property and
 * used as the per-file key. It cannot be the counterparty or the title, because
 * `Superseded by` implies a company can have several NDAs over time.
 *
 * Relations: the account name is looked up in Clients first, then Partners. If
 * neither matches, the record is still created with both relations empty rather
 * than dropped. `Superseded by` is deliberately never set — deciding which
 * agreement replaces which is a legal judgement, not something to infer.
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// NOTE the asymmetry: '*Venn Factory' carries a literal '*', 'VF accts' does not.
const ACCOUNTS_ROOT = '/Filing Cabinet/*Venn Factory/VF accts';
const CONTRACTS_SUBFOLDER = 'Contracts';

const NDA_DB_ID = '2378ebaf-15ee-8091-a178-e6cfda664c4e';
const CLIENTS_DB_ID = '39b8f7e7-362f-4121-8389-4d9f5c26c1d4';
const PARTNERS_DB_ID = '642b44e9-1363-4765-aaaf-702a708d6812';
// Client engagement financials (item 2). Client db here relates to the same
// Clients DB above, so the client match resolved for the NDA reuses directly.
const FIN_DB_ID = '1c68ebaf-15ee-8062-80b2-fcb378557689';
// Contract Intake Log — one row per processed file (any outcome). A file in
// the log is "completed" and skipped on future runs, closing the loop for
// documents that create no NDA record and no financials row (amendments,
// release forms, referrals) — which otherwise re-extract every run.
const LOG_DB_ID = '3ab8ebaf-15ee-81c9-9321-f6a93120d642';
// Notify Eve via her Office365 account (Graph /me/sendMail), matching the
// Outlook-credential pattern the email workflows use. Requires the Mail.Send
// scope on this credential.
const OUTLOOK_CREDENTIAL = { microsoftOutlookOAuth2Api: { id: 'xUInnrPuP6ogucEt', name: 'Microsoft Outlook account' } };
const NOTIFY_TO = 'eve@vennfactory.com';

const EXTRACTION_MODEL = 'claude-sonnet-5';

const DROPBOX_CREDENTIAL = {
  dropboxOAuth2Api: { id: '5p74zyJBc4pRsoO4', name: 'Dropbox account' },
};
const NOTION_CREDENTIAL = {
  notionApi: { id: 'lOLrwKiRnGrhZ9xM', name: 'Eve Notion Account' },
};
const ANTHROPIC_HEADER_AUTH = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

// The documents are NOT standalone NDAs. They are executed agreements of every
// kind — MSAs, advisory/consulting, sponsorship, referral, partnership, vendor,
// appearance — each carrying a confidentiality section. The job is to mine the
// NDA clauses out of whatever agreement arrives. An earlier version framed this
// as "extract terms from an NDA", which made the model editorialise ("This is a
// Background Check Release Form, not an NDA") into Special provisions instead of
// reporting the confidentiality terms.
const EXTRACTION_PROMPT = [
  'You are extracting the CONFIDENTIALITY / NON-DISCLOSURE provisions from an',
  'executed agreement.',
  '',
  'The document is usually NOT a standalone NDA. It is typically a master',
  'services, advisory, consulting, sponsorship, referral, partnership, vendor or',
  'appearance agreement — each of which contains a confidentiality section.',
  'Your job is to locate that section and report its terms.',
  '',
  '"We"/"us" refers to Venn Factory (also written VF or Venn Factory LLC).',
  'The other signing party is the counterparty.',
  '',
  'Call the record_nda tool exactly once. Rules:',
  '- Do NOT remark on whether the document "is an NDA". That it is some other',
  '  kind of agreement is expected. Just report the confidentiality terms.',
  '- Quote the agreement. Do not infer or invent terms that are not present.',
  '- If a field is genuinely absent, return an empty string (null for',
  '  effective_date). NEVER return a placeholder such as "<UNKNOWN>", "N/A",',
  '  "Unknown", "None" or "TBD".',
  '- counterparty_legal_name: the counterparty\'s formal legal entity from the',
  '  signature block. If truly not determinable, return an empty string.',
  '- effective_date must be YYYY-MM-DD. If the agreement is dated only by',
  '  signature, use the LATEST signature date. If no date is present, null.',
  '- term: the duration of the CONFIDENTIALITY obligations if stated separately;',
  '  otherwise the term of the agreement — say which one you are reporting.',
  '- post_termination_period: how long confidentiality survives termination or',
  '  expiry, e.g. "5 years from termination", "perpetual for trade secrets".',
  '- governing_law / venue: of the agreement, since these govern its',
  '  confidentiality section too.',
  '- special_provisions: confidentiality-specific carve-outs or unusual terms',
  '  ONLY (residuals clauses, trade-secret perpetuity, publicity or',
  '  non-disparagement restrictions, unusual permitted disclosures). Empty',
  '  string if the confidentiality terms are unremarkable.',
  '- document_type: a short label for what the document actually is, e.g.',
  '  "Master Services Agreement", "Advisory Agreement", "Mutual NDA",',
  '  "Sponsorship Agreement", "Statement of Work".',
  '- confidentiality_found: "Yes" if the document contains confidentiality or',
  '  non-disclosure provisions at all; "No" if it genuinely has none.',
  '- my_form is "Yes" only if this is clearly Venn Factory\'s own template',
  '  (e.g. VF is named first/as "Company", or VF branding/footers appear).',
  '  If it is plainly the counterparty\'s paper, "No". If unclear, "No".',
  '- term_end_date: the date the agreement/confidentiality term ENDS, as',
  '  YYYY-MM-DD, but ONLY when the document states an explicit calendar end',
  '  date. Convert whatever format it appears in (e.g. "12.31.2026" is',
  '  2026-12-31). Return null if the term ends on an event, is open-ended,',
  '  is expressed only as a duration, or is not stated. Do not compute it.',
  '- expired: your own read of whether the term has already ended. This is a',
  '  cross-check only; the authoritative value is computed from term_end_date.',
  '',
  'ALSO extract the COMMERCIAL terms of the overall agreement (not just the',
  'confidentiality section). These feed a separate engagement/financials record.',
  'Same rules: quote, do not invent, empty string / null when genuinely absent,',
  'never a placeholder.',
  '- engagement_start_date / engagement_end_date: YYYY-MM-DD bounds of the OVERALL',
  '  agreement term (distinct from confidentiality survival). null if not an',
  '  explicit calendar date.',
  '- relationship_auto_renew: "Yes" / "No" / "Unknown" — whether the OVERALL',
  '  relationship (not just confidentiality) auto-renews.',
  '- renewal_terms: how renewal works, quoted compactly (e.g. "auto-renews for',
  '  successive 1-year terms unless 30 days notice"). Empty if none.',
  '- termination_notice: the notice window to terminate for convenience (e.g.',
  '  "30 days written notice"). Empty if none / not terminable for convenience.',
  '- payment_terms: e.g. "Net 30", "Due on receipt". Empty if absent.',
  '- invoicing_schedule: when/how invoicing happens (e.g. "monthly in advance",',
  '  "on milestone completion", "50% upfront, 50% on delivery"). Empty if absent.',
  '- fees: the amounts — rates, retainer, fixed fee, per-cycle amount, currency —',
  '  summarised faithfully (e.g. "$8,000/month retainer", "€15,000 fixed").',
  '- deliverables: what Venn Factory is obligated to deliver, summarised. Empty',
  '  if none stated.',
  '- point_of_contact: the contractual point of contact (name, title, email,',
  '  phone as present in the document). Empty if none named.',
  '- special_obligations: NON-confidentiality obligations Venn Factory takes on',
  '  (exclusivity, non-compete, insurance, IP assignment, reporting duties,',
  '  etc.). Empty if none beyond the standard confidentiality ones.',
  '- open_questions: an array of short strings flagging anything you could NOT',
  '  determine that a human should resolve (e.g. "fee amount not stated in this',
  '  document — may be in an attached SOW"). Empty array if nothing is unclear.',
  '',
  'FINALLY, produce STRUCTURED commercial values for the financials database.',
  'These must be clean, typed values (the prose `fees`/`payment_terms` above stay',
  'as the human-readable reference). Amounts are PLAIN NUMBERS — no currency',
  'symbol, no commas (write 3300, not "$3,300").',
  '- fee_type: one of retainer (recurring fixed amount per period) | hourly |',
  '  one_time | per_event | contingent (e.g. % of a transaction / finder fee) |',
  '  none. This governs what is forecastable. A public-appearance / speaking',
  '  agreement with a fixed appearance fee is "per_event" (or "one_time" if a',
  '  single fixed fee). NEVER leave fee_type blank when a fee exists — pick the',
  '  closest type.',
  '- cycle_amount: the recurring per-period amount, as a number, ONLY when',
  '  fee_type is "retainer". null for hourly/contingent/one_time/per_event —',
  '  do NOT invent a recurring amount for non-recurring fees.',
  '- cycle_length: "Month" | "Quarter" | "Year" for a retainer; null otherwise.',
  '- cycle_count: number of cycles if the term is bounded and countable; null if',
  '  open-ended or not applicable.',
  '- currency: "USD" | "EUR" | "Other". If ANY amount (cycle_amount,',
  '  due_at_start, due_at_end) is set, currency MUST be set — infer "USD" from a',
  '  "$" and "EUR" from "€". Only null when there is genuinely no amount at all.',
  '- due_at_start: a one-time/upfront amount due at the start (e.g. a one-time',
  '  fee, a sponsorship fee due on execution), as a number; null if none.',
  '- due_at_end: a final/one-time amount due at the end, as a number; null if none.',
  '- payment_terms_normalized: one of "Due on receipt" | "Net 10" | "Net 15" |',
  '  "Net 30" | "Net 45" | "Other" | null (null if not stated).',
  '- engagement_type: one or more labels from EXACTLY this list, best-fitting',
  '  the agreement: Internal, Advisor, Advisory board, Workshop, Keynote,',
  '  Management board, Supervisory board, External, Public appearance,',
  '  Video production, Explore partnership, Sponsorship, Writing. Always assign',
  '  at least one when the agreement type is determinable (advisory/consulting',
  '  → "Advisor"; a standalone NDA exploring a deal → "Explore partnership";',
  '  a speaking engagement → "Public appearance").',
].join('\n');

// The tool schema forces well-shaped JSON back, so no response parsing is
// needed — the fields are read straight off the tool_use block.
const EXTRACTION_TOOL = {
  name: 'record_nda',
  description: 'Record the confidentiality terms AND the commercial terms extracted from an executed contract.',
  input_schema: {
    type: 'object',
    properties: {
      counterparty_legal_name: { type: 'string', description: 'Formal legal entity of the counterparty as written in the signature block, e.g. "Acme Corporation, Inc."' },
      effective_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if absent' },
      term: { type: 'string' },
      post_termination_period: { type: 'string', description: 'How long confidentiality obligations survive termination' },
      governing_law: { type: 'string', description: 'Governing law, e.g. "Delaware"' },
      venue: { type: 'string', description: 'Venue / forum for disputes' },
      special_provisions: { type: 'string', description: 'Confidentiality-specific carve-outs or unusual terms; empty string if unremarkable' },
      // Reporting/QA only — the NDAs database has no property for these. They
      // make the dry run legible (what kind of agreement was this?) and surface
      // the rare document that carries no confidentiality section at all.
      document_type: { type: 'string', description: 'What the document actually is, e.g. "Master Services Agreement", "Mutual NDA"' },
      confidentiality_found: { type: 'string', enum: ['Yes', 'No'], description: 'Does the document contain confidentiality/non-disclosure provisions at all?' },
      // Extracted as a first-class value so `Expired?` can be COMPUTED rather
      // than judged. Previously the end date existed only inside the free-text
      // `term`, so on every run the model had to re-read it from its own prose
      // and compare it to today in its head — which is why `expired` flipped
      // between runs (Partners Group: Yes/No/Yes) while every extracted field
      // stayed stable.
      term_end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD end date of the term, ONLY if an explicit calendar date is stated; null if event-based, open-ended, duration-only, or absent' },
      auto_renew: { type: 'string', enum: ['Yes', 'No'] },
      my_form: { type: 'string', enum: ['Yes', 'No'] },
      expired: { type: 'string', enum: ['Yes', 'No'], description: 'Cross-check only — the authoritative value is computed from term_end_date' },

      // --- Commercial terms (item 1 expansion; feed the engagement/financials
      // record built in item 2). NOT written to the NDAs DB — surfaced in the
      // dry-run preview so extraction quality can be reviewed before item 2. ---
      engagement_start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD start of the OVERALL agreement term, or null' },
      engagement_end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD end of the OVERALL agreement term, or null' },
      relationship_auto_renew: { type: 'string', enum: ['Yes', 'No', 'Unknown'], description: 'Whether the overall relationship auto-renews (not just confidentiality)' },
      renewal_terms: { type: 'string', description: 'How renewal works; empty if none' },
      termination_notice: { type: 'string', description: 'Notice window to terminate for convenience; empty if none' },
      payment_terms: { type: 'string', description: 'e.g. "Net 30", "Due on receipt"; empty if absent' },
      invoicing_schedule: { type: 'string', description: 'When/how invoicing happens; empty if absent' },
      fees: { type: 'string', description: 'Amounts/rates/retainer with currency, summarised; empty if absent' },
      deliverables: { type: 'string', description: 'What Venn Factory must deliver; empty if none' },
      point_of_contact: { type: 'string', description: 'Contractual POC (name/title/email/phone as present); empty if none' },
      special_obligations: { type: 'string', description: 'Non-confidentiality obligations VF takes on; empty if none' },
      open_questions: { type: 'array', items: { type: 'string' }, description: 'Unknowns a human should resolve; empty array if none' },

      // --- Structured commercial values (item 1.5) — map 1:1 into the Client
      // engagement financials DB columns in item 2. Amounts are plain numbers. ---
      fee_type: { type: 'string', enum: ['retainer', 'hourly', 'one_time', 'per_event', 'contingent', 'none'], description: 'What kind of fee; governs what is forecastable' },
      cycle_amount: { type: ['number', 'null'], description: 'Recurring per-period amount (plain number), ONLY when fee_type is retainer; null otherwise' },
      cycle_length: { type: ['string', 'null'], enum: ['Month', 'Quarter', 'Year', null], description: 'Recurring period for a retainer; null otherwise' },
      cycle_count: { type: ['number', 'null'], description: 'Number of cycles if bounded/countable; null if open-ended' },
      currency: { type: ['string', 'null'], enum: ['USD', 'EUR', 'Other', null], description: 'Currency of the amounts; null if no amount' },
      due_at_start: { type: ['number', 'null'], description: 'One-time/upfront amount due at start (plain number); null if none' },
      due_at_end: { type: ['number', 'null'], description: 'Final/one-time amount due at end (plain number); null if none' },
      payment_terms_normalized: { type: ['string', 'null'], enum: ['Due on receipt', 'Net 10', 'Net 15', 'Net 30', 'Net 45', 'Other', null], description: 'Normalized payment terms for the DB select; null if not stated' },
      engagement_type: { type: 'array', items: { type: 'string', enum: ['Internal', 'Advisor', 'Advisory board', 'Workshop', 'Keynote', 'Management board', 'Supervisory board', 'External', 'Public appearance', 'Video production', 'Explore partnership', 'Sponsorship', 'Writing'] }, description: 'Zero or more labels from the fixed list, best-fitting the agreement' },
    },
    required: [
      'counterparty_legal_name', 'effective_date', 'term', 'term_end_date',
      'post_termination_period', 'governing_law', 'venue', 'special_provisions',
      'document_type', 'confidentiality_found', 'auto_renew', 'my_form', 'expired',
      'engagement_start_date', 'engagement_end_date', 'relationship_auto_renew',
      'renewal_terms', 'termination_notice', 'payment_terms', 'invoicing_schedule',
      'fees', 'deliverables', 'point_of_contact', 'special_obligations', 'open_questions',
      'fee_type', 'cycle_amount', 'cycle_length', 'cycle_count', 'currency',
      'due_at_start', 'due_at_end', 'payment_terms_normalized', 'engagement_type',
    ],
  },
};

// ---------------------------------------------------------------------------
// Code: assemble the Notion create payload (pure in-memory JSON/string work —
// no HTTP and no binary, which is the only sanctioned use of a Code node here).
// Resolving the Client/Partner relation is a plain lookup against the two
// already-fetched page lists, so it costs no extra API calls per contract.
// ---------------------------------------------------------------------------
const BUILD_REQUEST_CODE = `
const NDA_DB_ID = ${JSON.stringify(NDA_DB_ID)};

// Notion page titles surface under different keys depending on the property
// name, so probe defensively rather than assuming one shape.
function titleOf(page) {
  const j = page.json || {};
  if (typeof j.name === 'string' && j.name) return j.name;
  for (const [k, v] of Object.entries(j)) {
    if (!k.startsWith('property_')) continue;
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0]) return v[0];
  }
  return '';
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function findPage(pages, accountName) {
  const want = norm(accountName);
  if (!want) return null;
  let hit = pages.find(p => norm(titleOf(p)) === want);
  if (hit) return hit;
  // Fall back to a containment match so "Acme" finds "Acme Corporation".
  hit = pages.find(p => {
    const t = norm(titleOf(p));
    return t && (t.includes(want) || want.includes(t));
  });
  return hit || null;
}

// ISO date strings compare correctly with <, so no date parsing is needed here
// either — the regex is a validity gate, not a parser.
const ISO = /^\\d{4}-\\d{2}-\\d{2}$/;
let today;
try { today = $now.toFormat('yyyy-MM-dd'); } catch (e) { today = new Date().toISOString().slice(0, 10); }

let clients = [], partners = [];
try { clients = $('Get Clients').all(); } catch (e) {}
try { partners = $('Get Partners').all(); } catch (e) {}

const out = [];
for (const item of $input.all()) {
  const j = item.json || {};
  const tool = (j.content || []).find(c => c && c.type === 'tool_use');
  const nda = (tool && tool.input) || {};

  const accountName = j.accountName || '';

  // Models sometimes emit a literal placeholder instead of an empty string, and
  // "<UNKNOWN>" is truthy — it would land in Notion verbatim. Treat any
  // placeholder as absent and fall back to the folder name.
  let cp = String(nda.counterparty_legal_name || '').trim();
  if (/^(n\\/?a|none|unknown|not specified|not stated|tbd|null)$/i.test(cp) || /^[<\\[(]/.test(cp)) cp = '';
  // On one-sided documents (an appearance release, say) the model can name OUR
  // side as the counterparty — a Commvault release came back as "Eve Maler".
  // We are never our own counterparty, so fall back to the account folder.
  if (/venn factory|\\beve maler\\b|\\bvf\\b/i.test(cp)) cp = '';
  const counterparty = cp || accountName;

  // Clients first, then Partners.
  const client = findPage(clients, accountName);
  const partner = client ? null : findPage(partners, accountName);

  // Disambiguate the title with the effective date. A client can hold several
  // agreements (Cyber1Armor and BalkanID each have two sponsorship agreements),
  // and "<co> NDA" alone made them indistinguishable in Notion. ISO dates keep
  // the titles alphabetically sortable within a client. Falls back to the bare
  // "<co> NDA" when the document carries no determinable date.
  const hasDate = nda.effective_date && ISO.test(nda.effective_date);
  const title = accountName + ' NDA' + (hasDate ? ' \\u2014 ' + nda.effective_date : '');

  // Expired? is COMPUTED, never taken from the model. An explicit end date in
  // the past means expired; anything else (event-based, open-ended, unstated)
  // stays "No" — the conservative default, which Eve can flip by hand for
  // events only she knows have happened.
  const endDate = (nda.term_end_date && ISO.test(nda.term_end_date)) ? nda.term_end_date : null;
  const expired = (endDate && endDate < today) ? 'Yes' : 'No';

  // What item 2 will do with this contract in the Client engagement financials
  // DB, decided from fee_type (Eli, 2026-07-27):
  //   retainer            -> row with a recurring cycle (Cycle payment/length/count)
  //   one_time / per_event -> row with a single Due-at-start amount
  //   hourly              -> SKIP (hard to forecast, very few; Eli 2026-07-27)
  //   contingent          -> SKIP (finder/% fees are not forecastable)
  //   none                -> SKIP (NDA-only / framework docs carry no financials)
  const FIN_ACTION = {
    retainer: 'row: recurring cycle',
    one_time: 'row: due at start',
    per_event: 'row: due at start',
    hourly: 'skip: not forecastable',
    contingent: 'skip: not forecastable',
    none: 'skip: no financials',
  };
  // Guard 1 (currency): if an amount is present but currency wasn't extracted,
  // default USD — these are overwhelmingly US contracts and the model reliably
  // catches EUR via the "€" sign. Deterministic beats re-prompting.
  const amtPresent = (nda.cycle_amount != null) || (nda.due_at_start != null) || (nda.due_at_end != null);
  const currency = nda.currency || (amtPresent ? 'USD' : null);

  // Guard 2 (never silently drop a fee): a known fee_type maps directly. A blank
  // or unrecognized fee_type that nonetheless clearly carries a fee (structured
  // amount, or a currency-amount in the prose) routes to REVIEW, not skip — so a
  // ~$10k appearance can't vanish just because fee_type didn't classify.
  let financials_action;
  if (FIN_ACTION[nda.fee_type]) {
    financials_action = FIN_ACTION[nda.fee_type];
  } else {
    const feePresent = amtPresent
      || /[$€£]\\s?[\\d,]|\\bUSD\\b|\\bEUR\\b|\\bper\\b[^.]*\\b(day|hour|month|year)\\b/i.test(String(nda.fees || ''));
    financials_action = feePresent ? 'review: unclassified fee' : 'skip: no financials';
  }

  const text = (v) => [{ text: { content: String(v || '').substring(0, 2000) } }];

  // -------------------------------------------------------------------------
  // Item 2: build the Client engagement financials row (or decide to skip).
  // Created for row:*/review:* actions; skipped for contingent/hourly/none.
  // Deduped on the Contract file URL against existing financials rows.
  // -------------------------------------------------------------------------
  const FIN_DB_ID = ${JSON.stringify(FIN_DB_ID)};
  let engagements = [];
  try { engagements = $('Get Existing Engagements').all(); } catch (e) {}

  const makeFinRow = financials_action.indexOf('row') === 0 || financials_action.indexOf('review') === 0;
  const finDupe = engagements.some((p) => (p.json.property_contract_file || '') === (j.ndaUrl || ''));
  const fin_create = makeFinRow && !finDupe;

  const engTypes = Array.isArray(nda.engagement_type) ? nda.engagement_type.filter(Boolean) : [];
  const primaryType = engTypes[0] || '';
  const finDateForTitle = (nda.engagement_start_date && ISO.test(nda.engagement_start_date))
    ? nda.engagement_start_date
    : (nda.effective_date && ISO.test(nda.effective_date) ? nda.effective_date : '');
  const fin_title = accountName
    + (primaryType ? ' \\u2014 ' + primaryType : '')
    + (finDateForTitle ? ' \\u2014 ' + finDateForTitle : '');

  let fin_requestBody = null;
  if (makeFinRow) {
    // Only send select values that already exist as options, so automation
    // never silently creates new options on this critical DB.
    const okCurrency = (currency === 'USD' || currency === 'EUR') ? currency : null;
    const okTerms = ['Due on receipt', 'Net 10', 'Net 15', 'Net 30', 'Net 45'].includes(nda.payment_terms_normalized)
      ? nda.payment_terms_normalized : null;
    const okCycleLen = ['Month', 'Quarter', 'Year'].includes(nda.cycle_length) ? nda.cycle_length : null;

    const finProps = {
      '-': { title: text(fin_title) },                          // the title property is literally named "-"
      'Contract file': { url: j.ndaUrl || null },               // dedup key
      'Point of contact': { rich_text: text(nda.point_of_contact) },
      'Non-standard obligations': { rich_text: text(nda.special_obligations) },
      'Relationship renewal': { select: { name: ['Yes', 'No', 'Unknown'].includes(nda.relationship_auto_renew) ? nda.relationship_auto_renew : 'Unknown' } },
      'Renewal terms': { rich_text: text(nda.renewal_terms) },
      'Termination notice': { rich_text: text(nda.termination_notice) },
      'Deliverables': { rich_text: text(nda.deliverables) },
      'Invoicing schedule': { rich_text: text(nda.invoicing_schedule) },
    };
    if (okCurrency) finProps['Currency'] = { select: { name: okCurrency } };
    if (nda.cycle_amount != null) finProps['Cycle payment'] = { number: nda.cycle_amount };
    if (okCycleLen) finProps['Cycle length'] = { select: { name: okCycleLen } };
    if (nda.cycle_count != null) finProps['Cycle count'] = { number: nda.cycle_count };
    if (nda.due_at_start != null) finProps['Due at start'] = { number: nda.due_at_start };
    if (nda.due_at_end != null) finProps['Due at end'] = { number: nda.due_at_end };
    if (okTerms) finProps['Payment terms'] = { select: { name: okTerms } };
    if (engTypes.length) finProps['Engagement type'] = { multi_select: engTypes.map((t) => ({ name: t })) };
    if (nda.engagement_start_date && ISO.test(nda.engagement_start_date)) {
      const range = { start: nda.engagement_start_date };
      if (nda.engagement_end_date && ISO.test(nda.engagement_end_date)) range.end = nda.engagement_end_date;
      finProps['Engagement start&end'] = { date: range };
    }
    if (nda.effective_date && ISO.test(nda.effective_date)) finProps['Effective date'] = { date: { start: nda.effective_date } };
    if (client) finProps['Client db'] = { relation: [{ id: client.json.id }] };

    // Page body: fee prose + open questions + the sales-pipeline reminder.
    const blk = (type, content) => ({ object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content: String(content).slice(0, 1900) } }] } });
    const children = [];
    if (nda.fees) { children.push(blk('heading_3', 'Fee detail')); children.push(blk('paragraph', nda.fees)); }
    const oq = (Array.isArray(nda.open_questions) ? nda.open_questions.slice() : []);
    oq.push('Sales pipeline not linked \\u2014 link this engagement to its pipeline item.');
    if (financials_action.indexOf('review') === 0) oq.push('Fee type unclassified \\u2014 review the fee structure and amounts.');
    children.push(blk('heading_3', 'For review'));
    oq.forEach((q) => children.push(blk('bulleted_list_item', q)));

    fin_requestBody = JSON.stringify({ parent: { database_id: FIN_DB_ID }, properties: finProps, children });
  }
  const properties = {
    '"<co> NDA"': { title: text(title) },
    'Counterparty': { rich_text: text(counterparty) },
    'NDA file': { url: j.ndaUrl || null },
    'Term': { rich_text: text(nda.term) },
    'Post-termination period': { rich_text: text(nda.post_termination_period) },
    'Governing law': { rich_text: text(nda.governing_law) },
    'Venue': { rich_text: text(nda.venue) },
    'Special provisions': { rich_text: text(nda.special_provisions) },
    'Auto-renew?': { select: { name: nda.auto_renew === 'Yes' ? 'Yes' : 'No' } },
    'My form?': { select: { name: nda.my_form === 'Yes' ? 'Yes' : 'No' } },
    'Expired?': { select: { name: expired } },
  };

  // Only send a date when we actually have one — Notion rejects a malformed date.
  if (nda.effective_date && /^\\d{4}-\\d{2}-\\d{2}$/.test(nda.effective_date)) {
    properties['Effective date'] = { date: { start: nda.effective_date } };
  }
  if (client) properties['Client record'] = { relation: [{ id: client.json.id }] };
  if (partner) properties['Partner record'] = { relation: [{ id: partner.json.id }] };

  // -------------------------------------------------------------------------
  // Intake log row (item: mark this file completed). Written for EVERY file
  // that reaches here, whatever the outcome, so it is never re-extracted.
  // -------------------------------------------------------------------------
  const LOG_DB_ID = ${JSON.stringify(LOG_DB_ID)};
  const ndaCreated = nda.confidentiality_found !== 'No';   // passes Has NDA Clauses
  let log_outcome;
  if (ndaCreated && fin_create) log_outcome = 'NDA + Financials';
  else if (ndaCreated) log_outcome = 'NDA record';
  else if (fin_create) log_outcome = 'Financials row';
  else if (financials_action.indexOf('skip: not forecastable') === 0) log_outcome = 'Skipped: not forecastable';
  else log_outcome = 'Skipped: no clauses';

  const oq = Array.isArray(nda.open_questions) ? nda.open_questions : [];
  const logNote = [
    (nda.document_type || '').trim(),
    nda.fees ? ('Fee: ' + nda.fees) : '',
    oq.length ? (oq.length + ' open question' + (oq.length > 1 ? 's' : '')) : '',
  ].filter(Boolean).join(' | ');
  const log_requestBody = JSON.stringify({
    parent: { database_id: LOG_DB_ID },
    properties: {
      'Name': { title: text((j.fileName || accountName || 'contract')) },
      'Contract file': { url: j.ndaUrl || null },
      'Account': { rich_text: text(accountName) },
      'Outcome': { select: { name: log_outcome } },
      'Processed': { date: { start: today } },
      'Notes': { rich_text: text(logNote) },
    },
  });

  // One-line HTML fragment for the notification email.
  const amtStr = nda.cycle_amount != null ? ((currency || '') + ' ' + nda.cycle_amount + '/' + (nda.cycle_length || ''))
    : (nda.due_at_start != null ? ((currency || '') + ' ' + nda.due_at_start + ' at start') : '');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const email_line = '<li><b>' + esc(counterparty || accountName) + '</b> (' + esc(accountName) + ') \\u2014 '
    + esc(nda.document_type || '') + '<br><b>Outcome:</b> ' + esc(log_outcome)
    + (amtStr ? ' \\u2014 ' + esc(amtStr) : '')
    + '<br><b>Effective:</b> ' + esc(nda.effective_date || '\\u2014')
    + ' | <b>Term:</b> ' + esc(nda.term || '\\u2014')
    + (nda.point_of_contact ? '<br><b>POC:</b> ' + esc(nda.point_of_contact) : '')
    + (oq.length ? '<br><b>For review:</b> ' + esc(oq.join('; ')) : '')
    + '</li>';

  out.push({
    json: {
      // Flat preview fields — this is what the dry run prints.
      account: accountName,
      title,
      file: j.filePath,
      counterparty,
      document_type: nda.document_type || '',
      confidentiality_found: nda.confidentiality_found || '',
      effective_date: nda.effective_date || null,
      term: nda.term || '',
      governing_law: nda.governing_law || '',
      venue: nda.venue || '',
      post_termination_period: nda.post_termination_period || '',
      special_provisions: nda.special_provisions || '',
      auto_renew: nda.auto_renew,
      my_form: nda.my_form,
      expired,                       // computed — what goes to Notion
      term_end_date: endDate,        // the input it was computed from
      expired_model: nda.expired,    // the model's own read, for comparison
      today,
      // --- commercial terms (item 1) — preview only; item 2 maps these into
      // the Client engagement financials record ---
      engagement_start_date: nda.engagement_start_date || null,
      engagement_end_date: nda.engagement_end_date || null,
      relationship_auto_renew: nda.relationship_auto_renew || '',
      renewal_terms: nda.renewal_terms || '',
      termination_notice: nda.termination_notice || '',
      payment_terms: nda.payment_terms || '',
      invoicing_schedule: nda.invoicing_schedule || '',
      fees: nda.fees || '',
      deliverables: nda.deliverables || '',
      point_of_contact: nda.point_of_contact || '',
      special_obligations: nda.special_obligations || '',
      open_questions: Array.isArray(nda.open_questions) ? nda.open_questions : [],
      // structured commercial values (item 1.5) → financials DB columns in item 2
      fee_type: nda.fee_type || '',
      cycle_amount: (nda.cycle_amount ?? null),
      cycle_length: nda.cycle_length || null,
      cycle_count: (nda.cycle_count ?? null),
      currency,                     // guard 1: defaulted to USD when an amount is present
      due_at_start: (nda.due_at_start ?? null),
      due_at_end: (nda.due_at_end ?? null),
      payment_terms_normalized: nda.payment_terms_normalized || null,
      engagement_type: Array.isArray(nda.engagement_type) ? nda.engagement_type : [],
      financials_action,            // what item 2 will do (computed from fee_type)
      // --- item 2 financials write ---
      fin_create,                   // true → a financials row will be created
      fin_dupe: finDupe,            // already recorded (Contract file match)
      fin_title,
      fin_requestBody,              // Notion POST /pages body (null when no row)
      // --- intake log + notification ---
      log_outcome,
      log_requestBody,              // Notion POST to the Contract Intake Log
      email_line,                   // HTML fragment for the digest email
      linked_to: client ? 'Client: ' + titleOf(client) : (partner ? 'Partner: ' + titleOf(partner) : 'NONE — link by hand'),
      ndaUrl: j.ndaUrl,
      requestBody: JSON.stringify({ parent: { database_id: NDA_DB_ID }, properties }),
    },
  });
}
return out;
`.trim();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// Weekdays at 07:00 (server local time). Hourly was far too frequent: executed
// contracts arrive a few times a month, and every run re-lists every account
// folder. A cron expression is used rather than the "weeks" interval because
// day-of-week is explicit here and doesn't depend on n8n's day-index convention.
const scheduleTrigger = createNode(
  'Schedule Trigger',
  'n8n-nodes-base.scheduleTrigger',
  { rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * 1-5' }] } },
  { position: [0, 300], typeVersion: 1.2 },
);

// Single obvious place to flip dry run off.
const config = createNode(
  'Config',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        // LIVE (items 1+2) as of 2026-07-27: writes both the NDA record and
        // the reconciled Client engagement financials row. Set true to pause.
        { id: 'c1a0f0e2-1111-4a11-9111-aaaaaaaaaaaa', name: 'dryRun', value: false, type: 'boolean' },
        // reviewAll bypasses the already-recorded dedup so a dry run re-extracts
        // EVERY contract (for reviewing extraction quality on the backlog). Safe
        // only alongside dryRun:true — it writes nothing. Set false for normal
        // operation so recorded contracts aren't re-downloaded/re-extracted.
        { id: 'c1a0f0e2-2222-4a22-9222-bbbbbbbbbbbb', name: 'reviewAll', value: false, type: 'boolean' },
      ],
    },
    options: {},
  },
  { position: [220, 300], typeVersion: 3.4 },
);

// --- Reference data, fetched once per run -----------------------------------
// These are chained (not parallel) so they are guaranteed to have run before
// the filter/Code node reference them. Each is followed by a Limit so the next
// node runs once rather than once per returned page.

function notionGetAll(name, dbId, position) {
  const n = createNode(
    name,
    'n8n-nodes-base.notion',
    {
      resource: 'databasePage',
      operation: 'getAll',
      databaseId: { __rl: true, mode: 'id', value: dbId },
      returnAll: true,
      filterType: 'none',
      options: {},
    },
    { position, typeVersion: 2.2, credentials: NOTION_CREDENTIAL },
  );
  n.alwaysOutputData = true;   // an empty database must not stall the chain
  return n;
}
function keepOne(name, position) {
  return createNode(name, 'n8n-nodes-base.limit', { maxItems: 1 }, { position, typeVersion: 1 });
}

const getExistingNdas = notionGetAll('Get Existing NDAs', NDA_DB_ID, [440, 300]);
const oneNda = keepOne('Keep One (NDAs)', [660, 300]);
const getClients = notionGetAll('Get Clients', CLIENTS_DB_ID, [880, 300]);
const oneClient = keepOne('Keep One (Clients)', [1100, 300]);
const getPartners = notionGetAll('Get Partners', PARTNERS_DB_ID, [1320, 300]);
const onePartner = keepOne('Keep One (Partners)', [1540, 300]);
// Existing financials rows, for the Contract-file dedup on the financials write.
const getEngagements = notionGetAll('Get Existing Engagements', FIN_DB_ID, [1760, 300]);
const oneEngagement = keepOne('Keep One (Engagements)', [1980, 300]);
// Processed-file log, for the "already completed" skip in Filter: Not Already Recorded.
const getIntakeLog = notionGetAll('Get Intake Log', LOG_DB_ID, [2200, 300]);
const oneIntakeLog = keepOne('Keep One (Intake Log)', [2420, 300]);

// --- Discover candidate files ----------------------------------------------

const listAccounts = createNode(
  'List Account Folders',
  'n8n-nodes-base.dropbox',
  { authentication: 'oAuth2', resource: 'folder', operation: 'list', path: ACCOUNTS_ROOT },
  { position: [1760, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);

const filterAccountFolders = createNode(
  'Filter: Account Folders',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: 'd1a0f0e2-2222-4a22-9222-bbbbbbbbbbbb',
          leftValue: '={{ $json.type }}',
          rightValue: 'folder',
          operator: { type: 'string', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [1980, 300], typeVersion: 2.2 },
);

// Runs once per account. An account with no Contracts folder errors; that must
// not abort the whole run, so continue and let the PDF filter drop the item.
const listContracts = createNode(
  'List Contracts Folder',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'folder',
    operation: 'list',
    path: `={{ $json.pathLower }}/${CONTRACTS_SUBFOLDER.toLowerCase()}`,
  },
  { position: [2200, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
listContracts.onError = 'continueRegularOutput';

// type === 'file' keeps drafts out twice over: the listing is non-recursive, and
// this drops the draft SUBFOLDER entries themselves (and any error items).
const filterPdfs = createNode(
  'Filter: PDFs Only',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'e1a0f0e2-3333-4a33-9333-cccccccccccc',
          leftValue: '={{ $json.type }}',
          rightValue: 'file',
          operator: { type: 'string', operation: 'equals' },
        },
        {
          id: 'e1a0f0e2-4444-4a44-9444-dddddddddddd',
          leftValue: "={{ ($json.name || '').toLowerCase().endsWith('.pdf') }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2420, 300], typeVersion: 2.2 },
);

// accountName is derived from the path by locating the accounts-root segment,
// so it survives a change of root without re-indexing by hand.
const buildCandidate = createNode(
  'Build Candidate',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        {
          id: 'f1a0f0e2-5555-4a55-9555-eeeeeeeeeeee',
          name: 'accountName',
          // Folders are named "acct <Company>" (e.g. "acct Twilio") but the
          // Clients/Partners databases hold the bare company ("Twilio"), so the
          // prefix is stripped here. Without this the title reads
          // "acct Twilio NDA" and relation matching relies on luck.
          value: `={{ $json.pathDisplay.split('/')[$json.pathDisplay.split('/').indexOf('${ACCOUNTS_ROOT.split('/').pop()}') + 1].replace(/^acct\\s+/i, '').trim() }}`,
          type: 'string',
        },
        { id: 'f1a0f0e2-6666-4a66-9666-ffffffffffff', name: 'filePath', value: '={{ $json.pathDisplay }}', type: 'string' },
        { id: 'f1a0f0e2-7777-4a77-9777-000000000001', name: 'fileName', value: '={{ $json.name }}', type: 'string' },
        // Normalised keys, precomputed so the dedup filter stays legible.
        { id: 'f1a0f0e2-9a9a-4a9a-999a-000000000009', name: 'fileKey', value: "={{ ($json.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') }}", type: 'string' },
        {
          id: 'f1a0f0e2-9b9b-4a9b-999b-00000000000a',
          name: 'acctKey',
          value: `={{ $json.pathDisplay.split('/')[$json.pathDisplay.split('/').indexOf('${ACCOUNTS_ROOT.split('/').pop()}') + 1].replace(/^acct\\s+/i, '').toLowerCase().replace(/[^a-z0-9]/g, '') }}`,
          type: 'string',
        },
        {
          id: 'f1a0f0e2-8888-4a88-9888-000000000002',
          name: 'ndaUrl',
          // Deterministic from the path: computable without an extra Dropbox
          // call, clickable for Eve, and stable enough to be the dedup key.
          value: "={{ 'https://www.dropbox.com/home' + encodeURI($json.pathDisplay.substring(0, $json.pathDisplay.lastIndexOf('/'))) + '?preview=' + encodeURIComponent($json.name) }}",
          type: 'string',
        },
      ],
    },
    options: {},
  },
  { position: [2640, 300], typeVersion: 3.4 },
);

// Dedup against what is already in Notion. Referencing the fetched pages avoids
// a per-file lookup entirely.
const filterNew = createNode(
  'Filter: Not Already Recorded',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'a2a0f0e2-9999-4a99-9999-000000000003',
          // Two-part match.
          // (1) exact ndaUrl — path-scoped, so it is precise by construction and
          //     catches everything this workflow has created.
          // (2) normalised FILENAME **scoped to the same client** — catches the
          //     legacy records Eve entered by hand, whose NDA file holds a
          //     Dropbox *shared* link (/scl/fi/<id>/<name>?rlkey=...) that our
          //     computed /home/ link can never equal. Without (2) the first live
          //     run would duplicate every contract already recorded.
          //
          // (2) MUST be client-scoped. A bare filename match is global, so two
          // different clients each filing a generic "Mutual NDA.pdf" would make
          // the second one vanish — a silently missing record, the worst failure
          // here. The counterparty check confines it to the same client, and is
          // required to be non-empty because ''.includes(x) is false but
          // x.includes('') is TRUE, which would otherwise match everything.
          // Multiple agreements from one client are separate documents with
          // separate filenames, so they still each get their own record.
          leftValue: "={{ $('Config').first().json.reviewAll === true || (!$('Get Intake Log').all().some(p => (p.json.property_contract_file || '') === $json.ndaUrl) && !$('Get Existing NDAs').all().some(p => (p.json.property_nda_file || '') === $json.ndaUrl || ((String(p.json.property_nda_file || '').split('?')[0].split('/').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') === $json.fileKey && String(p.json.property_counterparty || '').toLowerCase().replace(/[^a-z0-9]/g, '') !== '' && ($json.acctKey.includes(String(p.json.property_counterparty || '').toLowerCase().replace(/[^a-z0-9]/g, '')) || String(p.json.property_counterparty || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes($json.acctKey))))) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [2860, 300], typeVersion: 2.2 },
);

// --- Read and extract -------------------------------------------------------

const downloadContract = createNode(
  'Download Contract',
  'n8n-nodes-base.dropbox',
  { authentication: 'oAuth2', resource: 'file', operation: 'download', path: '={{ $json.filePath }}' },
  { position: [3080, 200], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
downloadContract.retryOnFail = true;
downloadContract.maxTries = 3;
downloadContract.waitBetweenTries = 2000;

const extractPdf = createNode(
  'Extract PDF Text',
  'n8n-nodes-base.extractFromFile',
  { operation: 'pdf', binaryPropertyName: 'data', options: {} },
  { position: [3300, 200], typeVersion: 1 },
);

const buildPrompt = createNode(
  'Build Prompt',
  'n8n-nodes-base.set',
  {
    assignments: {
      assignments: [
        // The model has no reliable notion of the current date, so `expired`
        // was guesswork: it marked a Partners Group agreement running through
        // 2026-12-31 as already expired. Inject the run date. (EXTRACTION_PROMPT
        // contains no braces, so it is safe to carry as an expression.)
        {
          id: 'b2a0f0e2-1010-4a10-9010-000000000004',
          name: 'prompt',
          value: '=' + EXTRACTION_PROMPT
            + "\n\nToday's date is {{ $now.toFormat('yyyy-MM-dd') }}."
            + ' Judge `expired` strictly against that date.',
          type: 'string',
        },
        // NDAs are short; the cap only guards against a pathological PDF.
        { id: 'b2a0f0e2-1111-4a11-9011-000000000005', name: 'contractText', value: "={{ ($json.text || '').slice(0, 60000) }}", type: 'string' },
        // The tool schema is carried as a LITERAL string (no leading '='), so
        // n8n never parses it as an expression. Inlining it into the request
        // expression broke the node: the schema contains '}}' sequences (e.g.
        // '"enum":["Yes","No"]}}'), and n8n's parser ends an expression at the
        // first '}}' it sees — producing "invalid syntax". Keep brace-heavy
        // JSON out of expressions and JSON.parse it back at point of use.
        { id: 'b2a0f0e2-1212-4a12-9012-000000000007', name: 'toolsJson', value: JSON.stringify([EXTRACTION_TOOL]), type: 'string' },
      ],
    },
    options: {},
  },
  { position: [3520, 200], typeVersion: 3.4 },
);

const extractFields = createNode(
  'Anthropic: Extract NDA Terms',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    // Must stay a single-line, brace-light expression — see toolsJson above.
    jsonBody: '={{ JSON.stringify({ model: ' + JSON.stringify(EXTRACTION_MODEL)
      + ', max_tokens: 2000, tools: JSON.parse($json.toolsJson)'
      + ', tool_choice: { type: "tool", name: "record_nda" }'
      + ', messages: [{ role: "user", content: $json.prompt + "\\n\\n--- CONTRACT ---\\n\\n" + $json.contractText }] }) }}',
    options: {
      timeout: 120000,
      // Throttle to one contract at a time with a gap between calls, so a
      // folder-wide sweep can't burst into the Anthropic rate limit.
      batching: { batch: { batchSize: 1, batchInterval: 2500 } },
    },
  },
  { position: [3740, 200], typeVersion: 4.2, credentials: ANTHROPIC_HEADER_AUTH },
);
extractFields.retryOnFail = true;
extractFields.maxTries = 3;
extractFields.waitBetweenTries = 3000;

// Rejoin the model output with the file metadata by position. The forked
// passthrough is safer than a paired-item lookup: every node between the fork
// and here is 1:1 and fails the run on error, so positions cannot drift.
const mergeExtraction = createNode(
  'Merge Terms + File',
  'n8n-nodes-base.merge',
  { mode: 'combine', combineBy: 'combineByPosition', options: {} },
  { position: [3960, 300], typeVersion: 3 },
);

const buildRequest = createNode(
  'Build NDA Record',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_REQUEST_CODE },
  { position: [4180, 300], typeVersion: 2 },
);

// --- Write (or report) ------------------------------------------------------

// A handful of files in Contracts carry no confidentiality provisions at all
// (an emailed amendment, a background-check release, a referral attachment
// whose confidentiality lives in its parent agreement). Recording those would
// put empty NDA columns in the register, so they are skipped.
//
// Deliberately fail-OPEN: only an explicit "No" skips. If the field were ever
// missing, this records the document — visible and correctable — rather than
// silently dropping a real agreement. Skipped items go to their own branch
// instead of vanishing, so the run always shows what it passed over.
const hasNdaClauses = createNode(
  'Has NDA Clauses?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'd3a0f0e2-1313-4a13-9013-000000000008',
          leftValue: "={{ $json.confidentiality_found !== 'No' }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4400, 300], typeVersion: 2.2 },
);

const skipped = createNode(
  'Skipped: No NDA Clauses',
  'n8n-nodes-base.noOp',
  {},
  { position: [4620, 560], typeVersion: 1 },
);

const isDryRun = createNode(
  'Dry Run?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'c2a0f0e2-1212-4a12-9012-000000000006',
          leftValue: "={{ $('Config').first().json.dryRun }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4620, 300], typeVersion: 2.2 },
);

// Dry run terminates here: the item already carries the flat preview fields.
const dryRunReport = createNode(
  'Would Create (Dry Run)',
  'n8n-nodes-base.noOp',
  {},
  { position: [4840, 200], typeVersion: 1 },
);

const createRecord = createNode(
  'Create NDA Record',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [4840, 400], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createRecord.retryOnFail = true;
createRecord.maxTries = 3;
createRecord.waitBetweenTries = 2000;

// ---------------------------------------------------------------------------
// Item 2: financials write branch (parallel to the NDA write, off the same
// Build NDA Record item). Independent gate: create a Client engagement
// financials row when fin_create is true (row:*/review:* and not a dupe).
// ---------------------------------------------------------------------------
const finGate = createNode(
  'Create Financials Row?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'f2a0f0e2-1313-4a13-9013-000000000010',
          leftValue: '={{ $json.fin_create }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4400, 760], typeVersion: 2.2 },
);

const finDryRun = createNode(
  'Financials Dry Run?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'f2a0f0e2-1414-4a14-9014-000000000011',
          leftValue: "={{ $('Config').first().json.dryRun }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4620, 760], typeVersion: 2.2 },
);

// Dry run terminates here — the item carries fin_title / fin_requestBody / the
// flat commercial preview fields.
const finDryRunReport = createNode(
  'Would Create Financials (Dry Run)',
  'n8n-nodes-base.noOp',
  {},
  { position: [4840, 660], typeVersion: 1 },
);

const createFinancials = createNode(
  'Create Financials Record',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.fin_requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [4840, 860], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createFinancials.retryOnFail = true;
createFinancials.maxTries = 3;
createFinancials.waitBetweenTries = 2000;

// ---------------------------------------------------------------------------
// Intake-log branch — one log row per processed file (marks it completed).
// ---------------------------------------------------------------------------
const logGate = createNode(
  'Write Log?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'f2a0f0e2-1515-4a15-9015-000000000012',
          leftValue: "={{ $('Config').first().json.dryRun }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4400, 1100], typeVersion: 2.2 },
);

const createLogRow = createNode(
  'Create Intake Log Row',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'notionApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.log_requestBody }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 334 } } },
  },
  { position: [4620, 1100], typeVersion: 4.2, credentials: NOTION_CREDENTIAL },
);
createLogRow.retryOnFail = true;
createLogRow.maxTries = 3;

// ---------------------------------------------------------------------------
// Notification branch — one digest email to Eve summarising the run, sent via
// her Office365 account (Graph /me/sendMail). Only fires when files were
// processed and not in dry run.
// ---------------------------------------------------------------------------
const aggregateForEmail = createNode(
  'Collect for Email',
  'n8n-nodes-base.aggregate',
  { aggregate: 'aggregateAllItemData', options: {} },
  { position: [4400, 1400], typeVersion: 1 },
);

const BUILD_EMAIL_CODE = `
const rows = $input.first().json.data || [];
if (!rows.length) return [];                     // nothing processed → no email
const dryRun = (() => { try { return $('Config').first().json.dryRun; } catch (e) { return false; } })();
if (dryRun) return [];

const lines = rows.map(r => r.email_line).filter(Boolean).join('\\n');
const created = rows.filter(r => r.log_outcome && r.log_outcome.indexOf('Skipped') !== 0).length;
const skipped = rows.length - created;
const today = (() => { try { return $now.toFormat('yyyy-MM-dd'); } catch (e) { return new Date().toISOString().slice(0,10); } })();

const subject = 'Contract intake ' + today + ': ' + rows.length + ' processed ('
  + created + ' recorded, ' + skipped + ' skipped)';
const html = '<html><body>'
  + '<p>The contract intake processed <b>' + rows.length + '</b> document'
  + (rows.length > 1 ? 's' : '') + ' on ' + today + '.</p>'
  + '<ul>' + lines + '</ul>'
  + '<p style="color:#888;font-size:12px">Automated by the contract intake workflow. '
  + 'Details are in the NDAs and Client engagement financials databases; every document is logged in Contract Intake Log.</p>'
  + '</body></html>';

const emailBody = {
  message: {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: ${JSON.stringify(NOTIFY_TO)} } }],
  },
  saveToSentItems: true,
};
return [{ json: { emailBody: JSON.stringify(emailBody) } }];
`.trim();

const buildEmail = createNode(
  'Build Email',
  'n8n-nodes-base.code',
  { mode: 'runOnceForAllItems', jsCode: BUILD_EMAIL_CODE },
  { position: [4620, 1400], typeVersion: 2 },
);

const sendEmail = createNode(
  'Notify Eve',
  'n8n-nodes-base.httpRequest',
  {
    method: 'POST',
    url: 'https://graph.microsoft.com/v1.0/me/sendMail',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'microsoftOutlookOAuth2Api',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ $json.emailBody }}',
    options: {},
  },
  { position: [4840, 1400], typeVersion: 4.2, credentials: OUTLOOK_CREDENTIAL },
);
sendEmail.retryOnFail = true;
sendEmail.maxTries = 3;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('Ingest NDA Contracts', {
  nodes: [
    scheduleTrigger, config,
    getExistingNdas, oneNda, getClients, oneClient, getPartners, onePartner,
    getEngagements, oneEngagement, getIntakeLog, oneIntakeLog,
    listAccounts, filterAccountFolders, listContracts, filterPdfs,
    buildCandidate, filterNew,
    downloadContract, extractPdf, buildPrompt, extractFields,
    mergeExtraction, buildRequest, hasNdaClauses, skipped, isDryRun, dryRunReport, createRecord,
    finGate, finDryRun, finDryRunReport, createFinancials,
    logGate, createLogRow, aggregateForEmail, buildEmail, sendEmail,
  ],
  connections: [
    connect(scheduleTrigger, config),
    // Reference data first, each collapsed to one item so the next runs once.
    connect(config, getExistingNdas),
    connect(getExistingNdas, oneNda),
    connect(oneNda, getClients),
    connect(getClients, oneClient),
    connect(oneClient, getPartners),
    connect(getPartners, onePartner),
    connect(onePartner, getEngagements),
    connect(getEngagements, oneEngagement),
    connect(oneEngagement, getIntakeLog),
    connect(getIntakeLog, oneIntakeLog),
    // Discover candidate files (after the reference-data chain completes)
    connect(oneIntakeLog, listAccounts),
    connect(listAccounts, filterAccountFolders),
    connect(filterAccountFolders, listContracts),
    connect(listContracts, filterPdfs),
    connect(filterPdfs, buildCandidate),
    connect(buildCandidate, filterNew),
    // Extract, then rejoin with the file metadata by position
    connect(filterNew, downloadContract),
    connect(downloadContract, extractPdf),
    connect(extractPdf, buildPrompt),
    connect(buildPrompt, extractFields),
    connect(extractFields, mergeExtraction, 0, 0),
    connect(filterNew, mergeExtraction, 0, 1),
    connect(mergeExtraction, buildRequest),
    connect(buildRequest, hasNdaClauses),
    connect(hasNdaClauses, isDryRun, 0),        // has confidentiality provisions
    connect(hasNdaClauses, skipped, 1),         // none found → skip, but stay visible
    connect(isDryRun, dryRunReport, 0),
    connect(isDryRun, createRecord, 1),
    // Financials write branch — parallel fork off the same built item
    connect(buildRequest, finGate),
    connect(finGate, finDryRun, 0),                 // fin_create true → proceed
    connect(finDryRun, finDryRunReport, 0),         // dry run → preview
    connect(finDryRun, createFinancials, 1),        // live → create financials row
    // Intake-log branch — log every processed file (live only)
    connect(buildRequest, logGate),
    connect(logGate, createLogRow, 1),              // not dry run → write log row
    // Notification branch — one digest email per run (live only, if any processed)
    connect(buildRequest, aggregateForEmail),
    connect(aggregateForEmail, buildEmail),
    connect(buildEmail, sendEmail),
  ],
  settings: { executionOrder: 'v1' },
});
