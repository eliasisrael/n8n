import { createWorkflow, createNode, connect } from '../lib/workflow.js';

const rssTrigger = createNode(
  'New Substack Post Published',
  'n8n-nodes-base.rssFeedReadTrigger',
  {
    pollTimes: {
      item: [
        {
          mode: 'everyHour',
          minute: 13,
        },
      ],
    },
    feedUrl: 'https://workshop.vennfactory.com/feed',
  },
  {
    typeVersion: 1,
    position: [-400, -896],
    id: '10ce0c51-58a4-43dd-bcdb-5d18a03d41d9',
  },
);
rssTrigger.retryOnFail = true;

const findExisting = createNode(
  'Find Existing Entries',
  'n8n-nodes-base.webflow',
  {
    operation: 'getAll',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099bacd3a32bb0fd072296',
    returnAll: true,
  },
  {
    typeVersion: 2,
    position: [-176, -896],
    id: '25233bd4-7b3e-467d-b89a-7bd831251c5c',
    credentials: {
      webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
    },
  },
);
findExisting.alwaysOutputData = true;
findExisting.retryOnFail = true;

const deDup = createNode(
  'De-Dup',
  'n8n-nodes-base.code',
  {
    jsCode: "let links = $input.all().filter(x => x.json.hasOwnProperty('fieldData')).map(x => x.json.fieldData[\"external-link\"]);\n\nlet result = $('New Substack Post Published').all().filter(x => !links.includes(x.json.link));\n\n\nreturn result;",
  },
  {
    typeVersion: 2,
    position: [48, -896],
    id: '25f71674-70b7-41aa-9390-e34b98b95db5',
  },
);

const reformat = createNode(
  'Reformat',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode: "// Add a new field called 'myNewField' to the JSON of the item\nconst cheerio = require(\"cheerio\");\nvar old = cheerio.load($input.item.json[\"content:encoded\"]);\n\n// const fixed = old(\"body > :first-child\").remove().html();\n// const fixed = \"<body>\"+$input.item.json[\"content:encoded\"]+\"</body>\";\n// old().wrap(\"<body></body>\");\nold(\"div:first-child.captioned-image-container\").remove();\nold(\"figure\").addClass('w-richtext-figure-type-image');\nold(\"img[width][height]\").attr('width',null).attr('height',null);\nold(\"a\").attr('target','_blank');\nold('[data-attrs]').attr('data-attrs',null);\n//old(\".button-wrapper\").remove();\nconst fixed = old.html().replace(/<html><head><\\/head><body>/, \"\").replace(/<\\/body><\\/html>/,\"\");\n\n$input.item.json[\"content:encoded\"] = fixed;\n\nreturn $input.item;",
  },
  {
    typeVersion: 2,
    position: [272, -896],
    id: '3bbd98bc-53ff-4925-a488-af1ff304b4ab',
  },
);
reformat.notesInFlow = true;
reformat.notes = 'Reformat Blog Post Body';

const postToWebflow = createNode(
  'Post to Webflow Blog Posts Collection',
  'n8n-nodes-base.webflow',
  {
    operation: 'create',
    siteId: '66022db75af9853636d1ce23',
    collectionId: '66099bacd3a32bb0fd072296',
    live: true,
    fieldsUi: {
      fieldValues: [
        { fieldId: 'name', fieldValue: '={{ $json.title }}' },
        { fieldId: 'body', fieldValue: "={{ $json['content:encoded'] }}" },
        { fieldId: 'header', fieldValue: '={{ $json.enclosure.url }}' },
        { fieldId: 'description', fieldValue: '={{ $json.contentSnippet }}' },
        { fieldId: 'category', fieldValue: 'Opinion' },
        { fieldId: 'external-link', fieldValue: '={{ $json.link }}' },
        { fieldId: 'substack-link', fieldValue: '={{ $json.link }}' },
      ],
    },
  },
  {
    typeVersion: 2,
    position: [496, -896],
    id: 'f6417174-385e-4e26-bece-c5e5d0c8f101',
    credentials: {
      webflowOAuth2Api: { id: '7uo2MfFKQm2Xiodm', name: 'Webflow account' },
    },
  },
);
postToWebflow.retryOnFail = true;

const sendEmail = createNode(
  'Send Email',
  'n8n-nodes-base.emailSend',
  {
    fromEmail: 'eli@heavylift.tech',
    toEmail: 'eve@xmlgrrl.com, eli@eliasisrael.com',
    subject: "=New Article Published: {{ $('Reformat').item.json.title }}",
    html: "=<html>\n<head></head>\n<body>\n<h1>New Article: {{ $('Reformat').item.json.title }}</h1>\n<p>A new article is published to VennFactory. Please <a href=\"https://www.vennfactory.com/blog-post/{{$('Post to Webflow Blog Posts Collection').item.json.fieldData.slug}}\"\">review it</a> for errors as soon as you can.</p>\n<div>\n{{ $('Reformat').item.json['content:encoded'] }}\n</div>\n</body>\n</html>",
    options: {
      appendAttribution: false,
    },
  },
  {
    typeVersion: 2.1,
    position: [720, -896],
    id: 'fd6e9650-d609-4c2a-b645-fd351fb701b6',
    credentials: {
      smtp: { id: 'oztI4hqIZ7r3dUx7', name: 'AWS SES SMTP' },
    },
  },
);
sendEmail.webhookId = '3ae3e02b-d1b7-4a59-b71b-e5cd8dbcb447';

const workflow = createWorkflow('Substack RSS Feed to Webflow Blog Collection', {
  nodes: [rssTrigger, postToWebflow, findExisting, deDup, reformat, sendEmail],
  connections: [
    connect(rssTrigger, findExisting),
    connect(findExisting, deDup),
    connect(deDup, reformat),
    connect(reformat, postToWebflow),
    connect(postToWebflow, sendEmail),
  ],
  settings: {
    executionOrder: 'v1',
    callerPolicy: 'workflowsFromSameOwner',
    errorWorkflow: 'EZTb8m4htw60nP0b',
  },
  tags: ['website', 'Production'],
});

// Server has an explicit empty output on Send Email
workflow.connections['Send Email'] = { main: [[]] };

export default workflow;
