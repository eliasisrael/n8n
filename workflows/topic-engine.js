/**
 * LinkedIn Daily Topic Engine
 *
 * Daily workflow that generates a digest of 3 ranked and framed LinkedIn
 * post topic candidates for Eli Israel. Pulls from Reddit, Hacker News,
 * Google News RSS, and tech RSS feeds. Filters by freshness, relevance
 * (LLM), and novelty (vs. topics-log). Ranks by engagement velocity,
 * topic fit, and angle availability. Frames top candidates with openers
 * in Eli's voice. Writes digest + CSV log to Dropbox.
 *
 * LLM calls via HTTP Request to Anthropic Messages API:
 *   1. Score & Angle (Haiku 3.5) — combined relevance + angle check
 *   2. Frame Topics (Sonnet 4.6) — creative writing in Eli's voice
 *
 * Flow:
 *   Schedule Trigger ──┬──→ Source Collection → Normalize → Merge ──→ Novelty → Score → Rank → Frame → Output
 *                      └──→ Download topics-log → Parse ────────────↗
 */

import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DROPBOX_CREDENTIAL = {
  dropboxOAuth2Api: { id: '5p74zyJBc4pRsoO4', name: 'Dropbox account' },
};

// Header Auth credential: header name = "x-api-key", value = Anthropic API key
const ANTHROPIC_HEADER_AUTH = {
  httpHeaderAuth: { id: 'JKGmltAERvaKJ6OS', name: 'Anthropic API Key' },
};

const REDDIT_CREDENTIAL = {
  redditOAuth2Api: { id: 'gPGt7Sn4pUebthnA', name: 'Reddit account' },
};

const TOPICS_LOG_PATH = '/Content-Creation/0-Topics/topics-log.csv';
const SCORE_MODEL = 'claude-haiku-4-5';
const FRAME_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Stage 0: Trigger + Side Branch
// ---------------------------------------------------------------------------

const scheduleTrigger = createNode(
  'Schedule Trigger',
  'n8n-nodes-base.scheduleTrigger',
  {
    rule: {
      interval: [{ field: 'days', triggerAtHour: 7 }],
    },
  },
  { position: [0, 300], typeVersion: 1.2 },
);

const downloadTopicsLog = createNode(
  'Download Topics Log',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'download',
    path: TOPICS_LOG_PATH,
  },
  { position: [300, 640], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
downloadTopicsLog.continueOnFail = true;

const parseTopicsLog = createNode(
  'Parse Topics Log',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
// Parse the topics-log CSV binary and extract titles from the last 60 days.
// If the CSV download failed (first run), output an empty array.
const item = $input.first();
let recentTitles = [];

try {
  const binaryKey = Object.keys(item.binary || {})[0];
  if (binaryKey) {
    const buffer = await this.helpers.getBinaryDataBuffer(0, binaryKey);
    const csvText = buffer.toString('utf8');
    const lines = csvText.split('\\n').filter(l => l.trim());
    // Skip header row
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const dateStr = (cols[0] || '').trim();
      const title = (cols[1] || '').trim();
      if (dateStr && title) {
        const rowDate = new Date(dateStr);
        if (rowDate >= sixtyDaysAgo) {
          recentTitles.push(title);
        }
      }
    }
  }
} catch (e) {
  // If parsing fails, proceed with empty list
}

return [{ json: { recentTitles } }];`,
  },
  { position: [600, 640], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Stage 1: Source Collection
// ---------------------------------------------------------------------------

const buildSourceList = createNode(
  'Build Source List',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const now = Math.floor(Date.now() / 1000);
const oneDayAgo = now - 86400;
const sources = [];

// Reddit (4 subreddits)
const subreddits = ['ExperiencedDevs', 'programming', 'devops', 'SoftwareEngineering'];
for (const sub of subreddits) {
  sources.push({
    url: 'https://oauth.reddit.com/r/' + sub + '/top.json?t=day&limit=25',
    sourceType: 'reddit',
    sourceName: 'reddit/' + sub,
  });
}

// Hacker News (5 keyword queries)
const hnKeywords = ['developer productivity', 'platform engineering', 'AI coding', 'vibe coding', 'developer experience'];
for (const kw of hnKeywords) {
  sources.push({
    url: 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(kw) + '&tags=story&numericFilters=created_at_i>' + oneDayAgo + '&hitsPerPage=10',
    sourceType: 'hackernews',
    sourceName: 'hackernews/' + kw,
  });
}

// Google News RSS (4 keyword queries)
const gnKeywords = ['platform engineering', 'AI coding tools', 'developer productivity', 'enterprise AI adoption'];
for (const kw of gnKeywords) {
  sources.push({
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(kw) + '&hl=en-US&gl=US&ceid=US:en',
    sourceType: 'googlenews',
    sourceName: 'googlenews/' + kw,
  });
}

// Tech RSS Feeds (2 feeds)
sources.push({ url: 'https://thenewstack.io/feed/', sourceType: 'rss', sourceName: 'rss/thenewstack' });
sources.push({ url: 'https://feed.infoq.com/', sourceType: 'rss', sourceName: 'rss/infoq' });

return sources.map(s => ({ json: s }));`,
  },
  { position: [300, 300], typeVersion: 2 },
);

// Split Reddit (needs OAuth) from other sources (no auth)
const splitBySource = createNode(
  'Split By Source',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.sourceType }}',
          rightValue: 'reddit',
          operator: {
            type: 'string',
            operation: 'equals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [600, 300], typeVersion: 2 },
);

const fetchReddit = createNode(
  'Fetch Reddit',
  'n8n-nodes-base.httpRequest',
  {
    url: '={{ $json.url }}',
    method: 'GET',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'redditOAuth2Api',
    options: {
      timeout: 15000,
    },
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'User-Agent', value: 'n8n-topic-engine/1.0' },
      ],
    },
  },
  { position: [900, 80], typeVersion: 4.2, credentials: REDDIT_CREDENTIAL },
);
fetchReddit.continueOnFail = true;
fetchReddit.onError = 'continueRegularOutput';

const fetchOtherSources = createNode(
  'Fetch Other Sources',
  'n8n-nodes-base.httpRequest',
  {
    url: '={{ $json.url }}',
    method: 'GET',
    options: {
      timeout: 15000,
    },
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'User-Agent', value: 'Mozilla/5.0 (compatible; n8n/1.0; +https://n8n.io)' },
      ],
    },
  },
  { position: [900, 520], typeVersion: 4.2 },
);
fetchOtherSources.continueOnFail = true;
fetchOtherSources.onError = 'continueRegularOutput';

const mergeRedditData = createNode(
  'Merge Reddit Data',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [1200, 80], typeVersion: 3 },
);

const mergeOtherData = createNode(
  'Merge Other Data',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [1200, 520], typeVersion: 3 },
);

const combineAllSources = createNode(
  'Combine All Sources',
  'n8n-nodes-base.merge',
  {
    mode: 'append',
    options: {},
  },
  { position: [1500, 300], typeVersion: 3 },
);

const normalizeAndDedup = createNode(
  'Normalize & Dedup',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const allItems = $input.all();
const items = [];
const now = Date.now();
const fortyEightHours = 48 * 60 * 60 * 1000;

for (const item of allItems) {
  const meta = item.json; // Contains merged: HTTP response + source metadata
  const sourceType = meta.sourceType;
  const sourceName = meta.sourceName;

  // Skip items where HTTP request failed
  if (meta.error || meta.code === 'ERR_') continue;

  try {
    if (sourceType === 'reddit') {
      const children = (meta.data && meta.data.children) || [];
      for (const child of children) {
        const d = child.data;
        if (!d) continue;
        items.push({
          id: d.url || d.id,
          title: d.title || '',
          url: d.url || ('https://reddit.com' + (d.permalink || '')),
          source: sourceName,
          published_at: new Date((d.created_utc || 0) * 1000).toISOString(),
          engagement_score: d.score || 0,
          summary: (d.selftext || '').substring(0, 500),
        });
      }
    } else if (sourceType === 'hackernews') {
      const hits = meta.hits || [];
      for (const hit of hits) {
        items.push({
          id: hit.url || hit.objectID,
          title: hit.title || '',
          url: hit.url || ('https://news.ycombinator.com/item?id=' + hit.objectID),
          source: sourceName,
          published_at: hit.created_at || new Date((hit.created_at_i || 0) * 1000).toISOString(),
          engagement_score: hit.points || 0,
          summary: (hit.story_text || '').substring(0, 500),
        });
      }
    } else if (sourceType === 'googlenews' || sourceType === 'rss') {
      // Parse RSS XML with regex (works for standard RSS feeds)
      const body = typeof meta === 'string' ? meta : (meta.data || '');
      const xmlStr = typeof body === 'string' ? body : JSON.stringify(body);
      const itemMatches = xmlStr.match(/<item[\\s\\S]*?<\\/item>/gi) || [];
      for (const xmlItem of itemMatches) {
        const titleMatch = xmlItem.match(/<title>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/title>/i);
        const linkMatch = xmlItem.match(/<link>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/link>/i);
        const pubDateMatch = xmlItem.match(/<pubDate>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/pubDate>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const url = linkMatch ? linkMatch[1].trim() : '';
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';
        if (title && url) {
          items.push({
            id: url,
            title,
            url,
            source: sourceName,
            published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
            engagement_score: 0,
            summary: '',
          });
        }
      }
    }
  } catch (e) {
    // Skip sources that fail to parse
    continue;
  }
}

// Freshness filter: keep only items from last 48 hours
const fresh = items.filter(item => {
  try {
    const pubTime = new Date(item.published_at).getTime();
    return (now - pubTime) < fortyEightHours;
  } catch (e) { return false; }
});

// Deduplicate by URL: keep higher engagement_score
const byUrl = new Map();
for (const item of fresh) {
  const existing = byUrl.get(item.url);
  if (!existing || item.engagement_score > existing.engagement_score) {
    byUrl.set(item.url, item);
  }
}

const deduped = Array.from(byUrl.values());
return deduped.map(item => ({ json: item }));`,
  },
  { position: [1800, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Stage 2: Novelty + Scoring
// ---------------------------------------------------------------------------

const mergeForNovelty = createNode(
  'Merge for Novelty',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [2160, 300], typeVersion: 3 },
);

const checkNovelty = createNode(
  'Check Novelty',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const allItems = $input.all();

// Get all fresh items (they come through from the merge)
const freshItems = allItems.map(i => i.json);

// Get recent titles from Parse Topics Log node
let recentTitles = [];
try {
  const logData = $('Parse Topics Log').first().json;
  recentTitles = logData.recentTitles || [];
} catch (e) {
  // First run or parse failed — no titles to check against
}

// Extract significant words (>4 chars) from a title
function getSignificantWords(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\\s]/g, '')
    .split(/\\s+/)
    .filter(w => w.length > 4);
}

const logWordSets = recentTitles.map(t => new Set(getSignificantWords(t)));

const survivors = freshItems.filter(item => {
  const itemWords = getSignificantWords(item.title || '');
  for (const logWords of logWordSets) {
    let overlap = 0;
    for (const w of itemWords) {
      if (logWords.has(w)) overlap++;
    }
    if (overlap >= 3) return false; // Too similar to a recent topic
  }
  return true;
});

if (survivors.length === 0) {
  return [{ json: { _empty: true } }];
}
return survivors.map(item => ({ json: item }));`,
  },
  { position: [2460, 300], typeVersion: 2 },
);

// --- LLM Call 1: Score & Angle (Haiku 3.5 via HTTP Request) ---

const buildScoreRequest = createNode(
  'Build Score Request',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const allItems = $input.all().map(i => i.json);

// Skip if no items survived filtering
if (allItems.length === 1 && allItems[0]._empty) {
  return [{ json: { _empty: true } }];
}

// Trim payload: only send id, title, source to save tokens
const trimmed = allItems.map(item => ({
  id: item.id,
  title: item.title,
  source: item.source,
}));

const prompt = \`You are evaluating news and discussion items for relevance to a LinkedIn content creator's topic areas.

The creator is Eli Israel, Managing Partner at Gartner, focused on enterprise software teams. His five content themes are:
1. AI in Software Development — pragmatic adoption, anti-hype, Spec-Driven Development, AI coding tools
2. Developer Experience & Productivity — DX as a measurable business lever, team velocity, retention
3. Platform Engineering & DevOps — platform ownership vs. tooling accumulation, path to production
4. Challenging Tech Narratives — picking apart oversimplified charts, "AI killed X" takes, enterprise hype
5. Personal & Community — health/resilience stories, amplifying founders and operators he believes in

For each item, return a JSON array where each element has:
- "id": the item's id field (return exactly as provided)
- "relevance": integer 0-10 (0 = irrelevant, 10 = perfect fit)
- "theme": which of the 5 themes it best fits, or "none"
- "reason": one sentence
- "has_angle": true or false — does it offer a clear contrarian, practitioner-focused, or analytically grounded angle?
- "angle_hint": one sentence describing the angle (only if has_angle is true, otherwise empty string)

Only return the JSON array. No explanation outside it.

Items to evaluate:
\${JSON.stringify(trimmed)}\`;

const requestBody = JSON.stringify({
  model: '${SCORE_MODEL}',
  max_tokens: 4096,
  messages: [{ role: 'user', content: prompt }],
});

return [{ json: { requestBody, itemsJson: JSON.stringify(allItems) } }];`,
  },
  { position: [2760, 300], typeVersion: 2 },
);

const ifHasScoreItems = createNode(
  'Has Score Items?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: {
            type: 'boolean',
            operation: 'notEquals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [3060, 300], typeVersion: 2 },
);

const scoreAndAngleApi = createNode(
  'Score & Angle API',
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
    jsonBody: '={{ $json.requestBody }}',
    options: {
      timeout: 120000,
    },
  },
  { position: [3360, 300], typeVersion: 4.2, credentials: ANTHROPIC_HEADER_AUTH },
);
scoreAndAngleApi.retryOnFail = true;

const mergeScores = createNode(
  'Merge Scores',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [3660, 300], typeVersion: 3 },
);

const applyScores = createNode(
  'Apply Scores',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const merged = $input.all();
const firstItem = merged[0].json;

// Extract LLM response text from Anthropic Messages API format
let llmText = '';
try {
  if (firstItem.content && Array.isArray(firstItem.content)) {
    llmText = firstItem.content.map(c => c.text || '').join('');
  }
} catch (e) {}

const itemsJson = firstItem.itemsJson || '[]';

let originalItems;
try {
  originalItems = JSON.parse(itemsJson);
} catch (e) {
  originalItems = [];
}

if (originalItems.length === 0) {
  return [{ json: { _empty: true } }];
}

// Parse LLM response
let scores;
try {
  // Extract JSON array from response (handle markdown code blocks)
  let jsonStr = llmText;
  const match = llmText.match(/\\[\\s*\\{[\\s\\S]*\\}\\s*\\]/);
  if (match) jsonStr = match[0];
  scores = JSON.parse(jsonStr);
} catch (e) {
  // If LLM response can't be parsed, pass all items through with neutral scores
  return originalItems.map(item => ({
    json: { ...item, relevance: 5, theme: 'none', has_angle: false, angle_hint: '' },
  }));
}

// Build lookup by id
const scoreMap = new Map();
for (const s of scores) {
  scoreMap.set(s.id, s);
}

// Merge scores into original items, filter by relevance >= 6
const results = [];
for (const item of originalItems) {
  const s = scoreMap.get(item.id);
  if (s && s.relevance >= 6) {
    results.push({
      json: {
        ...item,
        relevance: s.relevance,
        theme: s.theme || 'none',
        reason: s.reason || '',
        has_angle: s.has_angle || false,
        angle_hint: s.angle_hint || '',
      },
    });
  }
}

if (results.length === 0) {
  return [{ json: { _empty: true } }];
}
return results;`,
  },
  { position: [3960, 300], typeVersion: 2 },
);
applyScores.alwaysOutputData = true;

// ---------------------------------------------------------------------------
// Stage 3: Rank
// ---------------------------------------------------------------------------

const computeRankings = createNode(
  'Compute Final Rankings',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const allItems = $input.all().map(i => i.json);

// Skip if empty
if (allItems.length === 1 && allItems[0]._empty) {
  return [{ json: { _empty: true, items: [] } }];
}

const now = Date.now();

// D1: Engagement Velocity (0-10)
// For Reddit and HN: engagement_score / hours_since_published, normalized
// RSS items: 5 (neutral)
const velocities = allItems.map(item => {
  if (item.source.startsWith('reddit/') || item.source.startsWith('hackernews/')) {
    const hoursSince = Math.max(1, (now - new Date(item.published_at).getTime()) / 3600000);
    return item.engagement_score / hoursSince;
  }
  return -1; // marker for RSS
});

const maxVelocity = Math.max(...velocities.filter(v => v >= 0), 1);

const scored = allItems.map((item, i) => {
  const d1 = velocities[i] >= 0 ? Math.round((velocities[i] / maxVelocity) * 10) : 5;
  const d2 = item.relevance || 0;
  const angleBonus = item.has_angle ? 3 : 0;
  return {
    ...item,
    d1_velocity: d1,
    d2_topicFit: d2,
    angle_bonus: angleBonus,
    final_score: d1 + d2 + angleBonus,
  };
});

// Sort descending by final_score, take top 5
scored.sort((a, b) => b.final_score - a.final_score);
const top5 = scored.slice(0, 5);

return top5.map(item => ({ json: item }));`,
  },
  { position: [4320, 300], typeVersion: 2 },
);

// ---------------------------------------------------------------------------
// Stage 4: Frame & Output
// ---------------------------------------------------------------------------

// --- LLM Call 2: Frame Topics (Sonnet 4.6 via HTTP Request) ---

const buildFrameRequest = createNode(
  'Build Frame Request',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const allItems = $input.all().map(i => i.json);

if (allItems.length === 1 && allItems[0]._empty) {
  return [{ json: { _empty: true } }];
}

// Send more context for framing: id, title, url, source, theme, angle_hint
const trimmed = allItems.map(item => ({
  id: item.id,
  title: item.title,
  url: item.url,
  source: item.source,
  theme: item.theme,
  angle_hint: item.angle_hint || '',
}));

const prompt = \`You are helping Eli Israel identify and frame LinkedIn post topics. Eli is a Managing Partner at Gartner. His voice is direct, analytically grounded, and occasionally sardonic. He challenges oversimplified tech narratives and consistently sides with practitioners — people who build and deliver — over theorists. He does not moralize. He analyzes.

His opener style: strong declarative or contrarian statement. Never a question. Never a scene-setter.

For each item below, generate:
- "id": the item's id (return exactly as provided)
- "draft_opener": A punchy opening line in Eli's voice (one sentence, declarative, takes a position immediately)
- "angle": One sentence describing the contrarian or practitioner take
- "suggested_format": One of: Post, Long Post, Comment, Repost
- "theme": Which of Eli's five themes this fits best (1. AI in Software Development, 2. Developer Experience & Productivity, 3. Platform Engineering & DevOps, 4. Challenging Tech Narratives, 5. Personal & Community)

Items:
\${JSON.stringify(trimmed)}

Return a JSON array. One object per item.\`;

const requestBody = JSON.stringify({
  model: '${FRAME_MODEL}',
  max_tokens: 4096,
  messages: [{ role: 'user', content: prompt }],
});

return [{ json: { requestBody, itemsJson: JSON.stringify(allItems) } }];`,
  },
  { position: [4620, 300], typeVersion: 2 },
);

const ifHasFrameItems = createNode(
  'Has Frame Items?',
  'n8n-nodes-base.if',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json._empty }}',
          rightValue: true,
          operator: {
            type: 'boolean',
            operation: 'notEquals',
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [4920, 300], typeVersion: 2 },
);

const frameTopicsApi = createNode(
  'Frame Topics API',
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
    jsonBody: '={{ $json.requestBody }}',
    options: {
      timeout: 120000,
    },
  },
  { position: [5220, 300], typeVersion: 4.2, credentials: ANTHROPIC_HEADER_AUTH },
);
frameTopicsApi.retryOnFail = true;

const mergeFrames = createNode(
  'Merge Frames',
  'n8n-nodes-base.merge',
  {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  },
  { position: [5520, 300], typeVersion: 3 },
);

const buildOutputs = createNode(
  'Build Outputs',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const merged = $input.all();
const firstItem = merged[0].json;

// Generate today's date (used by all paths)
const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2, '0');
const dd = String(today.getDate()).padStart(2, '0');
const hh = String(today.getHours()).padStart(2, '0');
const min = String(today.getMinutes()).padStart(2, '0');
const dateStr = yyyy + '-' + mm + '-' + dd;

// Handle empty pipeline (no items survived filtering)
if (firstItem._empty) {
  const md = '# Daily Topic Digest \\u2014 ' + dateStr + '\\n'
    + '*Generated at ' + hh + ':' + min + ' CT | ' + dateStr + '*\\n\\n'
    + '> No topics passed relevance and novelty filters today.\\n';
  return [{ json: { markdown: md, newRows: [], dateStr } }];
}

// Extract LLM response text from Anthropic Messages API format
let llmText = '';
try {
  if (firstItem.content && Array.isArray(firstItem.content)) {
    llmText = firstItem.content.map(c => c.text || '').join('');
  }
} catch (e) {}

const itemsJson = firstItem.itemsJson || '[]';

let originalItems;
try {
  originalItems = JSON.parse(itemsJson);
} catch (e) {
  originalItems = [];
}

// Parse framing response
let frames;
try {
  let jsonStr = llmText;
  const match = llmText.match(/\\[\\s*\\{[\\s\\S]*\\}\\s*\\]/);
  if (match) jsonStr = match[0];
  frames = JSON.parse(jsonStr);
} catch (e) {
  frames = [];
}

// Merge frames into items
const frameMap = new Map();
for (const f of frames) {
  frameMap.set(f.id, f);
}

const framed = originalItems.map(item => {
  const f = frameMap.get(item.id) || {};
  return {
    ...item,
    draft_opener: f.draft_opener || '',
    angle: f.angle || item.angle_hint || '',
    suggested_format: f.suggested_format || 'Post',
    framed_theme: f.theme || item.theme || 'none',
  };
});

// Select top 3 by final_score (already sorted from ranking stage)
const top3 = framed.slice(0, 3);

// Count
const totalEvaluated = originalItems.length;
const warningLine = top3.length < 3
  ? '\\n> Warning: Only ' + top3.length + ' candidates passed filtering today.\\n'
  : '';

// Build markdown digest
let md = '# Daily Topic Digest \\u2014 ' + dateStr + '\\n';
md += '*Generated at ' + hh + ':' + min + ' CT | ' + dateStr + ' | ' + totalEvaluated + ' items evaluated*\\n';
md += warningLine;
md += '\\n---\\n';

top3.forEach((item, idx) => {
  md += '\\n## Topic ' + (idx + 1) + ' \\u2014 ' + (item.framed_theme || item.theme) + '\\n';
  md += '**' + item.title + '**\\n';
  md += 'Source: ' + item.source + ' | Suggested format: ' + item.suggested_format + '\\n';
  md += 'URL: ' + item.url + '\\n\\n';
  md += '**Angle:** ' + item.angle + '\\n';
  md += '**Draft opener:** ' + item.draft_opener + '\\n';
  md += '\\n---\\n';
});

md += '\\n*Full candidate pool: ' + totalEvaluated + ' items after filtering | Top 5 scored and framed | Top ' + top3.length + ' selected*\\n';

// Build new CSV rows as structured JSON (for downstream Convert to File node)
const newRows = top3.map(item => ({
  date: dateStr,
  title: item.title,
  theme: item.framed_theme || item.theme,
  format: item.suggested_format,
  status: 'Surfaced',
  source: 'n8n',
  notes: item.angle || '',
}));

return [{ json: { markdown: md, newRows, dateStr } }];`,
  },
  { position: [5820, 300], typeVersion: 2 },
);

// --- Write digest to Dropbox ---

const convertDigest = createNode(
  'Convert Digest',
  'n8n-nodes-base.convertToFile',
  {
    operation: 'toText',
    sourceProperty: 'markdown',
    options: {
      fileName: '={{ DateTime.now().toFormat("yyyy-MM-dd") }}_daily-topics.md',
    },
  },
  { position: [6120, 300], typeVersion: 1.1 },
);

const uploadDigest = createNode(
  'Upload Digest',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'upload',
    path: '=/Content-Creation/0-Topics/{{ DateTime.now().toFormat("yyyy-MM-dd") }}_daily-topics.md',
    binaryData: true,
    binaryPropertyName: 'data',
    overwrite: true,
  },
  { position: [6420, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
uploadDigest.retryOnFail = true;

// --- Append to topics-log.csv ---

const downloadCsv = createNode(
  'Download CSV',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'download',
    path: TOPICS_LOG_PATH,
  },
  { position: [6720, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
downloadCsv.continueOnFail = true;

const extractCsvRows = createNode(
  'Extract CSV Rows',
  'n8n-nodes-base.extractFromFile',
  {
    operation: 'csv',
    options: {},
  },
  { position: [7020, 100], typeVersion: 1 },
);
extractCsvRows.continueOnFail = true;
extractCsvRows.alwaysOutputData = true;

const buildNewCsvRows = createNode(
  'Build New CSV Rows',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForAllItems',
    jsCode: `\
const firstItem = $input.first().json;
const newRows = firstItem.newRows || [];
if (newRows.length === 0) {
  return [];
}
return newRows.map(row => ({ json: row }));`,
  },
  { position: [7020, 500], typeVersion: 2 },
);
buildNewCsvRows.alwaysOutputData = true;

const mergeForCsv = createNode(
  'Merge for CSV',
  'n8n-nodes-base.merge',
  {
    mode: 'append',
    options: {},
  },
  { position: [7320, 300], typeVersion: 3 },
);

const filterValidRows = createNode(
  'Filter Valid Rows',
  'n8n-nodes-base.filter',
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: crypto.randomUUID(),
          leftValue: '={{ $json.date }}',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  { position: [7620, 300], typeVersion: 2 },
);

const convertToCsv = createNode(
  'Convert to CSV',
  'n8n-nodes-base.convertToFile',
  {
    operation: 'csv',
    options: {
      fileName: 'topics-log.csv',
    },
  },
  { position: [7920, 300], typeVersion: 1.1 },
);

const uploadUpdatedCsv = createNode(
  'Upload Updated CSV',
  'n8n-nodes-base.dropbox',
  {
    authentication: 'oAuth2',
    resource: 'file',
    operation: 'upload',
    path: TOPICS_LOG_PATH,
    binaryData: true,
    binaryPropertyName: 'data',
    overwrite: true,
  },
  { position: [8220, 300], typeVersion: 1, credentials: DROPBOX_CREDENTIAL },
);
uploadUpdatedCsv.retryOnFail = true;

// ---------------------------------------------------------------------------
// Assemble Workflow
// ---------------------------------------------------------------------------

export default createWorkflow('LinkedIn Daily Topic Engine', {
  nodes: [
    // Stage 0
    scheduleTrigger, downloadTopicsLog, parseTopicsLog,
    // Stage 1
    buildSourceList, splitBySource, fetchReddit, fetchOtherSources,
    mergeRedditData, mergeOtherData, combineAllSources, normalizeAndDedup,
    // Stage 2
    mergeForNovelty, checkNovelty,
    buildScoreRequest, ifHasScoreItems, scoreAndAngleApi, mergeScores, applyScores,
    // Stage 3
    computeRankings,
    // Stage 4
    buildFrameRequest, ifHasFrameItems, frameTopicsApi, mergeFrames, buildOutputs,
    convertDigest, uploadDigest,
    downloadCsv, extractCsvRows, buildNewCsvRows,
    mergeForCsv, filterValidRows, convertToCsv, uploadUpdatedCsv,
  ],
  connections: [
    // Stage 0: Trigger → parallel branches
    connect(scheduleTrigger, buildSourceList),           // Branch 1: sources
    connect(scheduleTrigger, downloadTopicsLog),          // Branch 2: topics log
    connect(downloadTopicsLog, parseTopicsLog),

    // Stage 1: Source collection (split Reddit with OAuth vs others without)
    connect(buildSourceList, splitBySource),
    // Reddit branch (IF true = output 0)
    connect(splitBySource, fetchReddit, 0, 0),
    connect(fetchReddit, mergeRedditData, 0, 0),          // Reddit responses → input 0
    connect(splitBySource, mergeRedditData, 0, 1),        // Reddit metadata → input 1
    // Other sources branch (IF false = output 1)
    connect(splitBySource, fetchOtherSources, 1, 0),
    connect(fetchOtherSources, mergeOtherData, 0, 0),    // Other responses → input 0
    connect(splitBySource, mergeOtherData, 1, 1),         // Other metadata → input 1
    // Recombine all fetched sources
    connect(mergeRedditData, combineAllSources, 0, 0),
    connect(mergeOtherData, combineAllSources, 0, 1),
    connect(combineAllSources, normalizeAndDedup),

    // Stage 2: Novelty check
    connect(normalizeAndDedup, mergeForNovelty, 0, 0),    // Fresh items → input 0
    connect(parseTopicsLog, mergeForNovelty, 0, 1),       // Recent titles → input 1
    connect(mergeForNovelty, checkNovelty),

    // Stage 2: LLM scoring (via HTTP Request)
    connect(checkNovelty, buildScoreRequest),
    connect(buildScoreRequest, ifHasScoreItems),
    // True branch (output 0): has items → call API
    connect(ifHasScoreItems, scoreAndAngleApi, 0, 0),
    connect(scoreAndAngleApi, mergeScores, 0, 0),         // API response → input 0
    connect(buildScoreRequest, mergeScores, 0, 1),        // Original items → input 1
    connect(mergeScores, applyScores),
    // False branch (output 1): empty → skip API, go straight to rankings
    connect(ifHasScoreItems, computeRankings, 1, 0),

    // Stage 3: Ranking
    connect(applyScores, computeRankings),

    // Stage 4: Framing (via HTTP Request)
    connect(computeRankings, buildFrameRequest),
    connect(buildFrameRequest, ifHasFrameItems),
    // True branch (output 0): has items → call API
    connect(ifHasFrameItems, frameTopicsApi, 0, 0),
    connect(frameTopicsApi, mergeFrames, 0, 0),           // API response → input 0
    connect(buildFrameRequest, mergeFrames, 0, 1),        // Original items → input 1
    connect(mergeFrames, buildOutputs),
    // False branch (output 1): empty → skip API, go straight to outputs
    connect(ifHasFrameItems, buildOutputs, 1, 0),

    // Stage 4: Write digest
    connect(buildOutputs, convertDigest),
    connect(convertDigest, uploadDigest),

    // Stage 4: Append to CSV (Extract → Merge → Filter → Convert to File)
    connect(uploadDigest, downloadCsv),
    connect(downloadCsv, extractCsvRows),                 // CSV binary → Extract From File
    connect(buildOutputs, buildNewCsvRows),               // New rows JSON → split into items
    connect(extractCsvRows, mergeForCsv, 0, 0),           // Existing rows → input 0
    connect(buildNewCsvRows, mergeForCsv, 0, 1),          // New rows → input 1
    connect(mergeForCsv, filterValidRows),
    connect(filterValidRows, convertToCsv),
    connect(convertToCsv, uploadUpdatedCsv),
  ],
  settings: {
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['content', 'Production'],
});
