import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// --- Sticky Note ---
const stickyNote = createNode(
  'Sticky Note',
  'n8n-nodes-base.stickyNote',
  {
    content: '## Used By Create and Update\n\nThis sub-flow gets called in response to both creation and update of products',
    width: 340,
    color: 4,
  },
  {
    typeVersion: 1,
    position: [-160, -520],
    id: 'd7b353ee-0f93-43ca-ab09-c7578ba5cf79',
  }
);

// --- Trigger ---
const trigger = createNode(
  'When Executed by Another Workflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  {
    inputSource: 'passthrough',
  },
  {
    typeVersion: 1.1,
    position: [-120, -280],
    id: '0c4cf1b0-4f28-4c74-9891-60ce2281fa98',
  }
);

// --- Get Products from Thinkific ---
const getProducts = createNode(
  'Get Products from Thinkific',
  'n8n-nodes-base.graphql',
  {
    authentication: 'headerAuth',
    endpoint: 'https://api.thinkific.com/stable/graphql',
    query: `query ProductsQuery {
  site {
    products(first: 100) {
      nodes {
        id
        description
        productableType
        productableId
        additionalPrices(first: 100) {
          nodes {
            id
            amount
            currency
            displayPrice
            price
            priceType
          }
        }
        image {
          url
        }
        cardImageUrl
        categories(first:100) {
          nodes {
            id
            name
            position
            default
            slug
            createdAt
            updatedAt
          }
        }
        checkoutUrl
        landingPageUrl
        leadMagnet
        name
        primaryPrice {
            id
            amount
            currency
            displayPrice
            price
            priceType
        }
        slug
        status
        publishedAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`,
    variables: '{\n}',
  },
  {
    typeVersion: 1.1,
    position: [100, -280],
    id: 'a33d1d3d-ac0d-4b90-a0df-7ae02e630d97',
    credentials: {
      httpHeaderAuth: {
        id: '7hyPvqC7yRjkv2tK',
        name: 'Thinkific GraphQL Auth',
      },
    },
  }
);

// --- Split Thinkific Products ---
const splitProducts = createNode(
  'Split Thinkific Products',
  'n8n-nodes-base.splitOut',
  {
    fieldToSplitOut: 'data.site.products.nodes',
    options: {},
  },
  {
    typeVersion: 1,
    position: [320, -280],
    id: '6cfbf0b9-7d68-4fbc-a61a-682a571d17b3',
  }
);

// --- Update Notion (Execute Workflow) ---
const updateNotion = createNode(
  'Update Notion',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: 'tfhGFszmi3I3bAnp',
      mode: 'list',
      cachedResultName: 'Notion: Update Products',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        price: '={{ $json.primaryPrice.price }}',
        description: '={{ $json.description }}',
        thumbnail: '={{ $json.image.url }}',
        title: '={{ $json.name }}',
        product_type: '={{ $json.productableType }}',
        release_date: '={{ $json.publishedAt }}',
        product_page_link: '={{ $json.landingPageUrl }}',
        lms_id: '={{ $json.id }}',
        visible: "={{ $json.status == 'PUBLISHED'}}",
        product_categories: '={{ $json.categories.nodes.map(x => x.name) }}',
      },
      matchingColumns: [],
      schema: [
        {
          id: 'title',
          displayName: 'title',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'thumbnail',
          displayName: 'thumbnail',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'description',
          displayName: 'description',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'product_type',
          displayName: 'product_type',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'release_date',
          displayName: 'release_date',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'price',
          displayName: 'price',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'number',
          removed: false,
        },
        {
          id: 'product_page_link',
          displayName: 'product_page_link',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'lms_id',
          displayName: 'lms_id',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        },
        {
          id: 'visible',
          displayName: 'visible',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'boolean',
          removed: false,
        },
        {
          id: 'product_categories',
          displayName: 'product_categories',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'array',
          removed: false,
        },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {},
  },
  {
    typeVersion: 1.2,
    position: [760, -380],
    id: '2e1c6422-9ec8-431a-a37d-14b0ebc38175',
  }
);

// --- Build Variants (Code) ---
const buildVariants = createNode(
  'Build Variants',
  'n8n-nodes-base.code',
  {
    mode: 'runOnceForEachItem',
    jsCode:
      'const primary = $input.item.json.primaryPrice;\n\n$input.item.json.variants = [\n  {\n    "id": $input.item.json.id,\n    "title": $input.item.json.name,\n    "url": $input.item.json.landingPageUrl,\n    "sku": primary.id,\n    "price": primary.price,\n    "image_url": $input.item.json.cardImageUrl\n  }\n];\n\nreturn $input.item;',
  },
  {
    typeVersion: 2,
    position: [760, -180],
    id: '210be022-9a42-475d-ba85-6325ef8a2228',
  }
);

// --- Update Mailchimp (Execute Workflow) ---
const updateMailchimp = createNode(
  'Update Mailchimp',
  'n8n-nodes-base.executeWorkflow',
  {
    workflowId: {
      __rl: true,
      value: 'svWfaxpaUprHEiX9',
      mode: 'list',
      cachedResultName: 'Create or Update Product',
    },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        id: '={{ $json.id }}',
        title: '={{ $json.name }}',
        handle: '={{ $json.slug }}',
        url: '={{ $json.landingPageUrl }}',
        description: '={{ $json.description }}',
        type: '={{ $json.productableType }}',
        image_url: '={{ $json.image.url }}',
        publication_date: '={{ $json.publishedAt }}',
        variants: '={{ $json.variants }}',
      },
      matchingColumns: [],
      schema: [
        {
          id: 'id',
          displayName: 'id',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'title',
          displayName: 'title',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'handle',
          displayName: 'handle',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'url',
          displayName: 'url',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'description',
          displayName: 'description',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'type',
          displayName: 'type',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'image_url',
          displayName: 'image_url',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'publication_date',
          displayName: 'publication_date',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
        },
        {
          id: 'variants',
          displayName: 'variants',
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'array',
        },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: {},
  },
  {
    typeVersion: 1.2,
    position: [980, -180],
    id: '187994ed-3148-4ae0-a5f9-ff03169d0d49',
  }
);

// --- Connections ---
// Split outputs to both Build Variants and Update Notion (same output index 0)
const connections = [
  connect(trigger, getProducts),
  connect(getProducts, splitProducts),
  connect(splitProducts, buildVariants),
  connect(splitProducts, updateNotion),
  connect(buildVariants, updateMailchimp),
];

export default createWorkflow('Copy Products To Notion and Mailchimp', {
  nodes: [
    getProducts,
    splitProducts,
    updateNotion,
    updateMailchimp,
    trigger,
    buildVariants,
    stickyNote,
  ],
  connections,
  settings: {
    executionOrder: 'v1',
  },
});
